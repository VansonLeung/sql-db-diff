import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { connect, connectionOptions, quote } from '../electron/drivers';
import {
  compareTable,
  openResults,
  getRows,
  defaultKeys,
  normalize,
  schemaChanged,
} from '../electron/diff';
import { requestSchema } from '../electron/validation';

async function fixture(fn: (paths: { dir: string; a: string; b: string }) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'sqldiff-test-'));
  try {
    await fn({ dir, a: join(dir, 'a.db'), b: join(dir, 'b.db') });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
function seed(file: string, sql: string) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}
test('SQLite compares schemas, rows, field values and preserves source files', () =>
  fixture(async ({ dir, a, b }) => {
    seed(
      a,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER, data BLOB); INSERT INTO users VALUES (1,'Ada',9223372036854775807,x'00ff'),(2,NULL,2,NULL),(3,'gone',3,NULL);",
    );
    seed(
      b,
      "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, amount INTEGER, data BLOB, note TEXT); INSERT INTO users VALUES (1,'Ada Lovelace',9223372036854775807,x'00ff',NULL),(2,NULL,2,NULL,NULL),(4,'new',4,NULL,NULL);",
    );
    const original = await readFile(a);
    const left = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: a }),
      right = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: b });
    const db = openResults(join(dir, 'results.db'));
    try {
      const [at] = await left.inspect(),
        [bt] = await right.inspect();
      assert.equal(at.columns[0].pk, 1);
      const r = await compareTable(db, left, right, at, bt, defaultKeys(at, bt), false, () => {});
      assert.equal(r.state, 'done');
      assert.equal(r.schemaChanged, true);
      assert.deepEqual([r.added, r.removed, r.changed, r.equal], [1, 1, 2, 0]);
      const { rows, total } = getRows(db, at.id, 1, 'changed');
      assert.equal(total, 2);
      assert.equal(rows[0].left?.amount.value, '9223372036854775807');
      assert.equal(rows[0].left?.data.value, '00ff');
      assert.deepEqual(rows[0].fields, ['name', 'note']);
      assert.equal(rows[1].left?.name.type, 'null');
      assert.ok(!rows[1].left?.note);
      assert.equal(rows[1].right?.note.type, 'null');
      await assert.rejects(left.query('DELETE FROM users'), /readonly/);
    } finally {
      db.close();
      await left.close();
      await right.close();
    }
    assert.deepEqual(await readFile(a), original);
  }));
test('duplicate and nullable matching keys are errors, keyless tables are skipped', () =>
  fixture(async ({ dir, a, b }) => {
    seed(
      a,
      "CREATE TABLE entries (k TEXT, value TEXT); INSERT INTO entries VALUES ('x','1'),('x','2');",
    );
    seed(b, "CREATE TABLE entries (k TEXT, value TEXT); INSERT INTO entries VALUES ('x','1');");
    const left = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: a }),
      right = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: b }),
      db = openResults(join(dir, 'r.db'));
    try {
      const [at] = await left.inspect(),
        [bt] = await right.inspect();
      assert.deepEqual(defaultKeys(at, bt), []);
      assert.equal(
        (await compareTable(db, left, right, at, bt, [], false, () => {})).state,
        'skipped',
      );
      const result = await compareTable(db, left, right, at, bt, ['k'], false, () => {});
      assert.equal(result.state, 'error');
      assert.match(result.message!, /Duplicate/);
      assert.equal(getRows(db, at.id, 1).total, 0);
      assert.equal(
        (await compareTable(db, left, right, at, bt, ['missing'], false, () => {})).state,
        'error',
      );
    } finally {
      db.close();
      await left.close();
      await right.close();
    }
    seed(a, "DELETE FROM entries; INSERT INTO entries VALUES(NULL,'null-key');");
    const l = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: a }),
      r = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: b }),
      out = openResults(join(dir, 'r.db'));
    try {
      assert.match(
        (
          await compareTable(
            out,
            l,
            r,
            (await l.inspect())[0],
            (await r.inspect())[0],
            ['k'],
            false,
            () => {},
          )
        ).message!,
        /NULL/,
      );
    } finally {
      out.close();
      await l.close();
      await r.close();
    }
  }));
test('50,000-row tables stream to disk with accurate counts and paged results', () =>
  fixture(async ({ dir, a, b }) => {
    for (const [file, target] of [
      [a, false],
      [b, true],
    ] as const) {
      const db = new DatabaseSync(file);
      db.exec(
        'CREATE TABLE records (tenant INTEGER, id INTEGER, payload TEXT, PRIMARY KEY(tenant,id)); BEGIN',
      );
      const insert = db.prepare('INSERT INTO records VALUES (?,?,?)');
      for (let i = 0; i < 50000; i++)
        insert.run(1, i, target && i < 250 ? 'changed' : `value-${i}`);
      db.exec('COMMIT');
      db.close();
    }
    const left = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: a }),
      right = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: b }),
      db = openResults(join(dir, 'r.db'));
    let updates = 0;
    try {
      const at = (await left.inspect())[0],
        bt = (await right.inspect())[0];
      assert.deepEqual(defaultKeys(at, bt), ['tenant', 'id']);
      const result = await compareTable(
        db,
        left,
        right,
        at,
        bt,
        ['tenant', 'id'],
        false,
        () => updates++,
      );
      assert.deepEqual([result.changed, result.equal, result.scanned], [250, 49750, 100000]);
      assert.equal(updates, 100);
      assert.equal(getRows(db, at.id, 1).rows.length, 100);
      assert.equal(getRows(db, at.id, 3).rows.length, 50);
      assert.equal(getRows(db, at.id, 4).rows.length, 0);
      assert.equal(result.schemaChanged, false);
    } finally {
      db.close();
      await left.close();
      await right.close();
    }
  }));
test('source/target-only tables and schema-only mode', () =>
  fixture(async ({ dir, a, b }) => {
    seed(a, 'CREATE TABLE items(id INTEGER PRIMARY KEY); INSERT INTO items VALUES (1);');
    seed(b, 'CREATE TABLE other(id INTEGER PRIMARY KEY);');
    const l = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: a }),
      r = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: b }),
      db = openResults(join(dir, 'r.db'));
    try {
      const t = (await l.inspect())[0];
      assert.equal(
        (await compareTable(db, l, r, t, undefined, ['id'], false, () => {})).removed,
        1,
      );
      assert.equal((await compareTable(db, r, l, undefined, t, ['id'], false, () => {})).added, 1);
      assert.equal(
        (await compareTable(db, l, r, t, undefined, [], true, () => {})).state,
        'skipped',
      );
    } finally {
      db.close();
      await l.close();
      await r.close();
    }
  }));
test('canonical values distinguish NULL, text, binary and large integers', () => {
  assert.notDeepEqual(normalize({ v: null }), normalize({ v: 'null' }));
  assert.notDeepEqual(normalize({ v: 1n }), normalize({ v: '1' }));
  assert.deepEqual(normalize({ v: { b: 2, a: 1 } }), normalize({ v: { a: 1, b: 2 } }));
  assert.equal(quote('a"b', 'postgres'), '"a""b"');
  assert.equal(quote('a`b', 'mysql'), '`a``b`');
});
test('URL engine validation and selected database override', () => {
  assert.equal(
    connectionOptions(
      { id: '', name: '', engine: 'postgres', url: 'postgresql://a:p%40ss@localhost/original' },
      'target',
    ).database,
    'target',
  );
  assert.equal(
    connectionOptions({ id: '', name: '', engine: 'mysql', url: 'mysql://a:p%40ss@localhost/db' })
      .password,
    'p@ss',
  );
  assert.throws(
    () => connectionOptions({ id: '', name: '', engine: 'mysql', url: 'postgres://localhost/db' }),
    /engine/,
  );
  assert.throws(
    () =>
      connectionOptions({
        id: '',
        name: '',
        engine: 'postgres',
        url: 'postgres://localhost/db?sslmode=require',
      }),
    /verify-full/,
  );
  assert.throws(() =>
    requestSchema.parse({
      left: { bookmarkId: 'a', database: 'a' },
      right: { bookmarkId: 'b', database: 'b' },
      tables: [],
      keys: {},
      schemaOnly: false,
    }),
  );
});
