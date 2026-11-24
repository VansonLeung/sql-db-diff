import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { connect } from './drivers';
import { importSqlite } from './sqlite-import';
import { compareTable, getRows, openResults, defaultKeys } from './diff';
import type { Bookmark, ComparisonRequest, Progress } from '../src/shared';

async function run() {
  const { action, bookmark, database, path } = workerData;
  if (action === 'import-sqlite') return importSqlite(workerData.source, path);
  if (action === 'demo') {
    const bookmarks: Bookmark[] = [];
    for (const side of ['source', 'target']) {
      const file = join(path, `demo-${side}.sqlite`);
      const db = new DatabaseSync(file);
      db.exec(
        `CREATE TABLE IF NOT EXISTS customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, plan TEXT DEFAULT 'starter'); CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customers(id), total NUMERIC NOT NULL, status TEXT); CREATE TABLE IF NOT EXISTS events (event TEXT, created_at TEXT);`,
      );
      if (!db.prepare('SELECT count(*) AS n FROM customers').get()!.n) {
        db.exec(
          "INSERT INTO customers VALUES (1,'Ada Chen','ada@example.test','pro'),(2,'Sam Rivera','sam@example.test','starter'),(3,'Jordan Lee',NULL,'pro'); INSERT INTO orders VALUES (1001,1,49.95,'paid'),(1002,2,19.00,'pending'); INSERT INTO events VALUES ('signup','2026-01-01');",
        );
        if (side === 'target')
          db.exec(
            "UPDATE customers SET plan='enterprise' WHERE id=1; DELETE FROM customers WHERE id=3; INSERT INTO customers VALUES (4,'Alex Kim','alex@example.test','pro'); UPDATE orders SET status='paid' WHERE id=1002; ALTER TABLE orders ADD COLUMN note TEXT; CREATE TABLE subscriptions (id INTEGER PRIMARY KEY, customer_id INTEGER, active INTEGER);",
          );
      }
      db.close();
      bookmarks.push({
        id: `demo-${side}`,
        name: side === 'source' ? 'Demo · Source' : 'Demo · Target',
        engine: 'sqlite',
        file,
      });
    }
    return bookmarks;
  }
  if (action === 'rows') {
    // This is our private result database, not a user-selected source. SQLite on
    // macOS needs to recreate WAL sidecars when opening it in a fresh worker.
    const db = new DatabaseSync(path);
    db.exec('PRAGMA query_only=ON');
    try {
      return getRows(db, workerData.table, workerData.page, workerData.status);
    } finally {
      db.close();
    }
  }
  if (action !== 'compare') {
    const driver = await connect(bookmark, database);
    try {
      return action === 'inspect' ? await driver.inspect() : await driver.databases();
    } finally {
      await driver.close();
    }
  }
  const request: ComparisonRequest = workerData.request;
  let left, right;
  const db = openResults(path);
  const emit = (p: Omit<Progress, 'runId'>) =>
    parentPort!.postMessage({ progress: { ...p, runId: workerData.runId } });
  try {
    left = await connect(workerData.left, request.left.database);
    right = await connect(workerData.right, request.right.database);
    const [a, b] = await Promise.all([left.inspect(), right.inspect()]);
    let completed = 0;
    for (const id of request.tables) {
      const at = a.find((t) => t.id === id),
        bt = b.find((t) => t.id === id);
      if (!at && !bt) throw new Error('A selected table no longer exists. Reload tables.');
      const table = (at || bt)!;
      emit({
        state: 'running',
        completed,
        total: request.tables.length,
        table: table.name,
        scanned: 0,
      });
      const result = await compareTable(
        db,
        left,
        right,
        at,
        bt,
        request.keys[id] ?? defaultKeys(at, bt),
        request.schemaOnly,
        (scanned) =>
          emit({
            state: 'running',
            completed,
            total: request.tables.length,
            table: table.name,
            scanned,
          }),
      );
      emit({ state: 'running', completed: ++completed, total: request.tables.length, result });
    }
  } finally {
    await left?.close();
    await right?.close();
    db.close();
  }
  // Readers may start as soon as this event crosses the bridge. Close/checkpoint
  // the writer first so a new worker can open the result file read-only.
  emit({ state: 'done', completed: request.tables.length, total: request.tables.length });
}
run()
  .then((value) => parentPort!.postMessage({ value }))
  .catch((error) =>
    parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) }),
  )
  .finally(() => parentPort!.close());
