import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createService } from '../desktop/service';
import { BookmarkVault } from '../desktop/vault';
import { importSqlite } from '../desktop/sqlite-import';
import { createImportSession, cleanupStaleImports } from '../desktop/imports';
import { bookmarkSchema } from '../desktop/validation';
import { connect } from '../desktop/drivers';
import type { Bookmark, ComparisonRequest, Progress, TableMeta, RowDiff } from '../src/shared';
import { PASTED_SQL_DATABASE, SQL_TEXT_LIMIT } from '../src/shared';
const docker = promisify(execFile);

async function fixture(
  run: (
    root: string,
    service: Awaited<ReturnType<typeof createService>>,
    events: Progress[],
  ) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), 'sql-diff-import-'));
  let key: string | null = null;
  const events: Progress[] = [];
  const service = await createService({
    dataRoot: root,
    workerPath: join(import.meta.dir, '../desktop/worker.ts'),
    vault: new BookmarkVault(root, {
      get: async () => key,
      set: async (value) => {
        key = value;
      },
    }),
    chooseFile: async () => undefined,
    onProgress: (p) => events.push(p),
  });
  try {
    await run(root, service, events);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
}
async function comparison(
  service: Awaited<ReturnType<typeof createService>>,
  events: Progress[],
  left: Bookmark,
  right: Bookmark,
  database = 'sqldiff',
) {
  const endpoint = (b: Bookmark) => ({
    bookmarkId: b.id,
    database:
      b.engine === 'sqlite' ? (b.sqlSource === 'text' ? PASTED_SQL_DATABASE : b.file!) : database,
  });
  await service.invoke('bookmarks:save', [left]);
  await service.invoke('bookmarks:save', [right]);
  const request: ComparisonRequest = {
    left: endpoint(left),
    right: endpoint(right),
    tables: [
      JSON.stringify(
        left.engine === 'sqlite'
          ? ['main', 'items']
          : left.engine === 'postgres'
            ? ['public', 'items']
            : ['database', 'items'],
      ),
    ],
    keys: {},
    schemaOnly: false,
  };
  const id = await service.invoke('compare:start', [request]);
  const deadline = Date.now() + 300_000;
  while (!events.some((p) => p.runId === id && p.state !== 'running')) {
    assert.ok(Date.now() < deadline, JSON.stringify(events));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const terminal = events.find((p) => p.runId === id && p.state !== 'running')!;
  assert.equal(terminal.state, 'done', terminal.message);
  const result = events.find((p) => p.runId === id && p.result)?.result;
  assert.ok(result);
  return { result, request };
}
const sqliteDDL = 'CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, n INTEGER, bytes BLOB);';
const bookmark = (file: string, id: string): Bookmark => ({
  id,
  name: id,
  engine: 'sqlite',
  input: 'sql',
  sqlContent: 'data',
  file,
});

test('SQL bookmarks preserve legacy databases and require explicit content/dialect settings', () => {
  assert.ok(
    bookmarkSchema.safeParse({ id: 'a', name: 'a', engine: 'sqlite', file: 'a.db' }).success,
  );
  assert.equal(
    bookmarkSchema.safeParse({ id: 'a', name: 'a', engine: 'sqlite', input: 'sql', file: 'a.sql' })
      .success,
    false,
  );
  assert.equal(
    bookmarkSchema.safeParse({ ...bookmark('a.sql', 'a'), sqlVersion: '8.4' }).success,
    false,
  );
  const pasted: Bookmark = {
    id: 'paste',
    name: 'paste',
    input: 'sql',
    engine: 'sqlite',
    sqlSource: 'text',
    sqlContent: 'schema',
    sqlText: sqliteDDL,
  };
  assert.equal(bookmarkSchema.safeParse(pasted).success, true);
  assert.equal(bookmarkSchema.safeParse({ ...pasted, sqlText: ' \n\t' }).success, false);
  assert.equal(
    bookmarkSchema.safeParse({ ...pasted, sqlText: undefined, file: 'unused.sql' }).success,
    false,
  );
  assert.equal(
    bookmarkSchema.safeParse({ ...pasted, sqlText: 'a'.repeat(SQL_TEXT_LIMIT + 1) }).success,
    false,
  );
});

test('pasted SQLite SQL compares against text, files and databases, persists encrypted, and refreshes after edits', () =>
  fixture(async (root, service, events) => {
    const file = join(root, 'dump.sql');
    const originalSQL = `${sqliteDDL}\nINSERT INTO items VALUES(1,'貼上 SQL — old',9223372036854775807,x'00ff'),(2,'same',NULL,NULL);\n`;
    const targetSQL = originalSQL.replace('old', 'new');
    await writeFile(file, targetSQL);
    const left: Bookmark = {
      id: 'pasted',
      name: 'Pasted input',
      engine: 'sqlite',
      input: 'sql',
      sqlSource: 'text',
      sqlContent: 'data',
      sqlText: originalSQL,
      file: join(root, 'does-not-exist.sql'),
    };
    const right = bookmark(file, 'file');
    assert.deepEqual(await service.invoke('connection:test', [left]), [PASTED_SQL_DATABASE]);
    await service.invoke('bookmarks:save', [left]);
    const tables = (await service.invoke('schema:inspect', [
      { bookmarkId: left.id, database: PASTED_SQL_DATABASE },
    ])) as TableMeta[];
    assert.equal(tables[0].name, 'items');
    let { result, request } = await comparison(service, events, left, right);
    assert.deepEqual([result.schemaChanged, result.changed, result.equal], [false, 1, 1]);
    const rows = (await service.invoke('compare:rows', [result.id, 1, 'changed'])) as {
      rows: RowDiff[];
    };
    assert.equal(rows.rows[0].left?.n.value, '9223372036854775807');
    assert.equal(rows.rows[0].left?.bytes.value, '00ff');
    assert.equal(
      ((await service.invoke('bookmarks:list', [])) as Bookmark[]).find((b) => b.id === left.id)
        ?.sqlText,
      originalSQL,
    );
    assert.equal(
      (await readFile(join(root, 'bookmarks.enc'))).includes(Buffer.from('貼上 SQL')),
      false,
    );
    const textTarget: Bookmark = {
      ...left,
      id: 'text-target',
      sqlText: targetSQL,
      file: undefined,
    };
    ({ result } = await comparison(service, events, left, textTarget));
    assert.deepEqual([result.changed, result.equal], [1, 1]);
    ({ result } = await comparison(service, events, { ...left, sqlText: targetSQL }, textTarget));
    assert.equal(result.equal, 2);
    const live = join(root, 'live.sqlite');
    await importSqlite(file, live);
    const liveBefore = await readFile(live);
    const database: Bookmark = { id: 'db', name: 'db', engine: 'sqlite', file: live };
    ({ result } = await comparison(service, events, left, database));
    assert.deepEqual([result.changed, result.equal], [1, 1]);
    ({ result } = await comparison(service, events, database, left));
    assert.equal(result.changed, 1);
    ({ result } = await comparison(
      service,
      events,
      { ...left, sqlText: sqliteDDL, sqlContent: 'schema' },
      right,
    ));
    assert.equal(result.state, 'skipped');
    ({ result } = await comparison(service, events, { ...left, sqlText: sqliteDDL }, right));
    assert.equal(result.added, 2);
    assert.deepEqual(await readFile(live), liveBefore);
    assert.deepEqual(await readFile(file, 'utf8'), targetSQL);
    await assert.rejects(
      service.invoke('connection:test', [{ ...left, sqlText: `${sqliteDDL} INVALID SQL;` }]),
      /SQLite SQL import failed/,
    );
    assert.deepEqual(await readdir(join(root, 'imports')), []);
    await service.invoke('compare:start', [request]);
    await service.invoke('compare:cancel', []);
    assert.deepEqual(await readdir(join(root, 'imports')), []);
  }));

test('pasted SQL is staged exactly in private temporary storage and removed after a failed import', () =>
  fixture(async (root) => {
    const session = await createImportSession(join(root, 'imports'), new AbortController().signal);
    const sqlText = sqliteDDL + "\nINSERT INTO items(id,name) VALUES(1,'$() `literal` 貼上');\n";
    let staged: string | undefined;
    try {
      await assert.rejects(
        session.prepare(
          {
            id: 'text',
            name: 'text',
            engine: 'sqlite',
            input: 'sql',
            sqlSource: 'text',
            sqlText,
            sqlContent: 'data',
          },
          async (source) => {
            staged = source;
            assert.equal(await readFile(source, 'utf8'), sqlText);
            throw new Error('Deliberate import failure');
          },
        ),
        /Deliberate import failure/,
      );
    } finally {
      await session.cleanup();
    }
    assert.ok(staged);
    await assert.rejects(readFile(staged), { code: 'ENOENT' });
  }));

test('SQLite SQL import preserves source, precision, binary values and compares files and databases', () =>
  fixture(async (root, service, events) => {
    const a = join(root, 'a.sql'),
      b = join(root, 'b.sql'),
      live = join(root, 'live.sqlite');
    await writeFile(
      a,
      `PRAGMA foreign_keys=OFF; BEGIN TRANSACTION; ${sqliteDDL} INSERT INTO items VALUES(1,'old',9223372036854775807,x'00ff'),(2,'same',NULL,NULL),(3,'removed',0,NULL); COMMIT;`,
    );
    await writeFile(
      b,
      `${sqliteDDL} INSERT INTO items VALUES(1,'new',9223372036854775807,x'00ff'),(2,'same',NULL,NULL),(4,'added',0,NULL);`,
    );
    const original = await readFile(a);
    const left = bookmark(a, 'left'),
      right = bookmark(b, 'right');
    assert.deepEqual(await service.invoke('connection:test', [left]), [a]);
    const inspected = (await service.invoke('schema:inspect', [
      {
        bookmarkId: ((await service.invoke('bookmarks:save', [left])) as Bookmark).id,
        database: a,
      },
    ])) as TableMeta[];
    assert.equal(inspected[0].name, 'items');
    let { result, request } = await comparison(service, events, left, right);
    assert.deepEqual(
      [result.schemaChanged, result.added, result.removed, result.changed, result.equal],
      [false, 1, 1, 1, 1],
    );
    const rows = (await service.invoke('compare:rows', [result.id, 1, 'changed'])) as {
      rows: RowDiff[];
    };
    assert.equal(rows.rows[0].left?.n.value, '9223372036854775807');
    assert.equal(rows.rows[0].left?.bytes.value, '00ff');
    await importSqlite(b, live);
    const before = await readFile(live);
    const database: Bookmark = { id: 'live', name: 'live', engine: 'sqlite', file: live };
    ({ result } = await comparison(service, events, left, database));
    assert.deepEqual([result.added, result.removed, result.changed, result.equal], [1, 1, 1, 1]);
    ({ result } = await comparison(service, events, database, left));
    assert.deepEqual([result.added, result.removed, result.changed, result.equal], [1, 1, 1, 1]);
    assert.deepEqual(await readFile(live), before);
    assert.deepEqual(await readFile(a), original);
    assert.deepEqual(await readdir(join(root, 'imports')), []);
    await service.invoke('compare:start', [request]);
    await service.invoke('compare:cancel', []);
    assert.deepEqual(await readdir(join(root, 'imports')), []);
    assert.deepEqual(await readdir(join(root, 'comparisons')), []);
  }));

test('schema-only files force schema comparison; empty full exports still compare rows; changed files are reimported', () =>
  fixture(async (root, service, events) => {
    const a = join(root, 'empty.sql'),
      b = join(root, 'data.sql');
    await writeFile(a, sqliteDDL);
    await writeFile(b, `${sqliteDDL} INSERT INTO items(id,name) VALUES(1,'present');`);
    const left = bookmark(a, 'left'),
      right = bookmark(b, 'right');
    let { result } = await comparison(service, events, { ...left, sqlContent: 'schema' }, right);
    assert.equal(result.state, 'skipped');
    assert.equal(result.added, 0);
    ({ result } = await comparison(service, events, left, right));
    assert.equal(result.added, 1);
    await writeFile(a, `${sqliteDDL} INSERT INTO items(id,name) VALUES(1,'present');`);
    ({ result } = await comparison(service, events, left, right));
    assert.equal(result.equal, 1);
  }));

test('invalid SQLite SQL fails without leaving partial imports or changing external files', () =>
  fixture(async (root, service) => {
    const external = join(root, 'external.sqlite');
    const db = new DatabaseSync(external);
    db.exec('CREATE TABLE safe(id INTEGER);');
    db.close();
    const before = await readFile(external);
    for (const [i, sql] of [
      `ATTACH '${external.replaceAll("'", "''")}' AS external; DROP TABLE external.safe;`,
      'PRAGMA writable_schema=ON;',
      "SELECT load_extension('bad');",
      '.read external.sql',
      `${sqliteDDL} INSERT INTO missing VALUES(1);`,
      `BEGIN; ${sqliteDDL}`,
      'INSERT INTO missing VALUES(1);',
      '-- empty file',
    ].entries()) {
      const file = join(root, `bad-${i}.sql`);
      await writeFile(file, sql);
      await assert.rejects(
        service.invoke('connection:test', [bookmark(file, 'bad')]),
        /SQLite SQL import failed/,
      );
      assert.deepEqual(await readdir(join(root, 'imports')), []);
    }
    assert.deepEqual(await readFile(external), before);
  }));

for (const engine of ['postgres', 'mysql'] as const)
  test(
    `${engine} SQL inputs: native file/text restoration, database comparisons and cleanup`,
    { skip: !process.env.TEST_SQL_IMPORT_DOCKER },
    () =>
      fixture(async (root, service, events) => {
        const a = join(root, 'a.sql'),
          b = join(root, 'b.sql');
        const ddl =
          'CREATE TABLE items(id BIGINT PRIMARY KEY, name VARCHAR(80), n DECIMAL(30,8)); CREATE INDEX items_name ON items(name);';
        const pgData =
          'COPY public.items (id, name, n) FROM stdin;\n1\told\t12345678901234567890.12345678\n2\tsame\t\\N\n\\.\n';
        const myProcedure =
          'DELIMITER ;;\nCREATE PROCEDURE noop() BEGIN SELECT 1; END;;\nDELIMITER ;\n';
        await writeFile(
          a,
          `${ddl}\n${engine === 'postgres' ? pgData : "INSERT INTO items VALUES(1,'old',12345678901234567890.12345678),(2,'same',NULL);\n" + myProcedure}`,
        );
        await writeFile(
          b,
          `${ddl} INSERT INTO items VALUES(1,'new',12345678901234567890.12345678),(2,'same',NULL),(3,'added',0);`,
        );
        const left: Bookmark = {
          id: 'left',
          name: 'left',
          engine,
          input: 'sql',
          sqlContent: 'data',
          file: a,
          sqlVersion:
            engine === 'postgres' ? process.env.TEST_SQL_IMPORT_PG_VERSION || '18' : '8.4',
        };
        const right: Bookmark = { ...left, id: 'right', name: 'right', file: b };
        assert.deepEqual(await service.invoke('connection:test', [left]), ['sqldiff']);
        await service.invoke('bookmarks:save', [left]);
        const tables = (await service.invoke('schema:inspect', [
          { bookmarkId: 'left', database: 'sqldiff' },
        ])) as TableMeta[];
        assert.equal(tables[0].name, 'items');
        assert.ok(tables[0].indexes.length);
        let { result, request } = await comparison(service, events, left, right);
        assert.deepEqual(
          [result.schemaChanged, result.added, result.removed, result.changed, result.equal],
          [false, 1, 0, 1, 1],
        );
        const rows = (await service.invoke('compare:rows', [result.id, 1, 'changed'])) as {
          rows: RowDiff[];
        };
        assert.equal(rows.rows[0].left?.n.value, '12345678901234567890.12345678');
        const pasted: Bookmark = {
          ...left,
          id: 'pasted',
          file: undefined,
          sqlSource: 'text',
          sqlText: await readFile(a, 'utf8'),
        };
        ({ result } = await comparison(service, events, pasted, right));
        assert.deepEqual(
          [result.schemaChanged, result.added, result.changed, result.equal],
          [false, 1, 1, 1],
        );
        const session = await createImportSession(
          join(root, 'imports'),
          new AbortController().signal,
        );
        try {
          const { bookmark: live } = await session.prepare(right, importSqlite);
          ({ result } = await comparison(service, events, pasted, { ...live, id: 'live' }));
          assert.deepEqual([result.added, result.changed, result.equal], [1, 1, 1]);
          const driver = await connect(live);
          try {
            assert.equal((await driver.inspect())[0].name, 'items');
            await assert.rejects(driver.query('DELETE FROM items'), /read.only/i);
          } finally {
            await driver.close();
          }
        } finally {
          await session.cleanup();
        }
        assert.deepEqual(await readdir(join(root, 'imports')), []);
        const broken = join(root, 'broken.sql');
        await writeFile(broken, `${ddl} THIS IS INVALID SQL;`);
        await assert.rejects(
          service.invoke('connection:test', [{ ...left, file: broken }]),
          /could not be restored/,
        );
        assert.deepEqual(await readdir(join(root, 'imports')), []);
        const named = join(root, 'named.sql');
        await writeFile(
          named,
          engine === 'postgres'
            ? `CREATE DATABASE exported;\n\\connect exported\n${ddl}`
            : `CREATE DATABASE exported; USE exported; ${ddl}`,
        );
        assert.deepEqual(await service.invoke('connection:test', [{ ...left, file: named }]), [
          'exported',
        ]);
        // Simulate an abandoned import; startup cleanup must remove its containers and volumes.
        const abandoned = await createImportSession(
          join(root, 'imports'),
          new AbortController().signal,
        );
        await abandoned.prepare(left, importSqlite);
        const abandonedResources = JSON.parse(
          await readFile(join(abandoned.dir, 'resources.json'), 'utf8'),
        );
        await cleanupStaleImports(join(root, 'imports'));
        await assert.rejects(docker('docker', ['inspect', abandonedResources.containers[0]]));
        // Cancel after Docker has actually created a container, rather than before preparation starts.
        await service.invoke('compare:start', [request]);
        let container: string | undefined;
        const deadline = Date.now() + 30_000;
        while (!container) {
          assert.ok(Date.now() < deadline, 'Import did not start a container.');
          for (const name of await readdir(join(root, 'imports'))) {
            try {
              const record = JSON.parse(
                await readFile(join(root, 'imports', name, 'resources.json'), 'utf8'),
              );
              const candidate = record.containers[0];
              if (candidate) {
                await docker('docker', ['inspect', candidate]);
                container = candidate;
              }
            } catch {
              /* Resource creation may still be in progress. */
            }
          }
          if (!container) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        await service.invoke('compare:cancel', []);
        await assert.rejects(docker('docker', ['inspect', container]));
        assert.deepEqual(await readdir(join(root, 'imports')), []);
        await cleanupStaleImports(join(root, 'imports'));
      }),
  );
