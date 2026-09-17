import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BookmarkVault, type KeyStore } from '../desktop/vault';
import { acquireInstance } from '../desktop/instance';
import { createService } from '../desktop/service';
import type { Bookmark, Progress, TableMeta } from '../src/shared';

async function fixture(run: (root: string, keys: KeyStore) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'sql-diff-desktop-'));
  let value: string | null = null;
  try {
    await run(root, {
      get: async () => value,
      set: async (next) => {
        value = next;
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('vault encrypts bookmarks, survives reopening, and rejects tampering or missing keys', () =>
  fixture(async (root, keys) => {
    const data: Bookmark[] = [
      {
        id: 'test',
        name: 'Private connection',
        engine: 'mysql',
        password: 'not plaintext',
        ssh: { enabled: true, privateKey: 'ssh secret' },
      },
    ];
    await new BookmarkVault(root, keys).write(data);
    const bytes = await readFile(join(root, 'bookmarks.enc'));
    assert.equal(bytes.includes(Buffer.from('not plaintext')), false);
    assert.deepEqual(await new BookmarkVault(root, keys).read(), data);
    const missing = new BookmarkVault(root, {
      get: async () => null,
      set: async () => {
        throw new Error('Must not recreate a missing key.');
      },
    });
    await assert.rejects(missing.read(), /credential store/);
    const changed = Buffer.from(bytes);
    changed[changed.length - 1] ^= 1;
    await writeFile(join(root, 'bookmarks.enc'), changed);
    await assert.rejects(new BookmarkVault(root, keys).read());
    await writeFile(join(root, 'bookmarks.enc'), 'legacy encrypted bytes');
    await assert.rejects(new BookmarkVault(root, keys).read(), /Legacy Electron/);
    assert.equal(await readFile(join(root, 'bookmarks.enc'), 'utf8'), 'legacy encrypted bytes');
  }));

test('vault fails closed when OS key storage is unavailable', () =>
  fixture(async (root) => {
    const vault = new BookmarkVault(root, {
      get: async () => null,
      set: async () => {
        throw new Error('Locked keychain');
      },
    });
    await assert.rejects(vault.write([]), /credential store/);
    await assert.rejects(readFile(join(root, 'bookmarks.enc')), { code: 'ENOENT' });
  }));

test('instance lock rejects a second launch and is reusable after shutdown', () =>
  fixture(async (root) => {
    const release = await acquireInstance(root);
    await assert.rejects(acquireInstance(root), /already running/);
    await release();
    await (
      await acquireInstance(root)
    )();
  }));

test('service uses real Bun workers, validates requests, streams results, cancels and cleans up', () =>
  fixture(async (root, keys) => {
    const events: Progress[] = [];
    const service = await createService({
      dataRoot: root,
      workerPath: join(import.meta.dir, '../desktop/worker.ts'),
      vault: new BookmarkVault(root, keys),
      chooseFile: async () => undefined,
      onProgress: (p) => events.push(p),
    });
    try {
      await assert.rejects(service.invoke('__proto__', []), /Unknown/);
      await assert.rejects(service.invoke('bookmarks:save', [{ engine: 'invalid' }]));
      const bookmarks = (await service.invoke('demo:create', [])) as Bookmark[];
      const left = { bookmarkId: bookmarks[0].id, database: bookmarks[0].file! };
      const right = { bookmarkId: bookmarks[1].id, database: bookmarks[1].file! };
      const tables = (await service.invoke('schema:inspect', [left])) as TableMeta[];
      const request = { left, right, tables: tables.map((t) => t.id), keys: {}, schemaOnly: false };
      const run = await service.invoke('compare:start', [request]);
      const deadline = Date.now() + 10_000;
      while (!events.some((p) => p.runId === run && p.state === 'done')) {
        assert.ok(Date.now() < deadline, JSON.stringify(events));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const result = (await service.invoke('compare:rows', [tables[0].id, 1])) as { total: number };
      assert.equal(result.total, 3);
      await assert.rejects(service.invoke('compare:rows', [tables[0].id, -1]));
      await service.invoke('compare:start', [request]);
      await service.invoke('compare:cancel', []);
      await assert.rejects(
        service.invoke('compare:rows', [tables[0].id, 1]),
        /after the comparison/,
      );
      assert.deepEqual(await readdir(join(root, 'comparisons')), []);
    } finally {
      await service.close();
    }
    await assert.rejects(service.invoke('bookmarks:list', []), /closing/);
  }));
