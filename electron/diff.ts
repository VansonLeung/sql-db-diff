import { DatabaseSync } from 'node:sqlite';
import type { DataRow, Value, TableMeta, TableResult, RowDiff } from '../src/shared';
import type { Driver } from './drivers';

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, stable(v)]),
    );
  return value;
}
export function valueOf(v: unknown): Value {
  if (v === null || v === undefined) return { type: 'null', value: null };
  if (typeof v === 'bigint') return { type: 'integer', value: v.toString() };
  if (v instanceof Uint8Array) return { type: 'binary', value: Buffer.from(v).toString('hex') };
  if (v instanceof Date) return { type: 'date', value: v.toISOString() };
  if (typeof v === 'number' && !Number.isFinite(v)) return { type: 'number', value: String(v) };
  return { type: typeof v, value: stable(v) };
}
export function normalize(row: Record<string, unknown>): DataRow {
  return Object.fromEntries(
    Object.keys(row)
      .sort()
      .map((k) => [k, valueOf(row[k])]),
  );
}
export function schemaChanged(a?: TableMeta, b?: TableMeta): boolean {
  if (!a || !b) return true;
  const shape = (t: TableMeta) => ({
    columns: t.columns,
    indexes: [...t.indexes].sort(),
    constraints: [...t.constraints].sort(),
    definition: t.definition,
  });
  return JSON.stringify(shape(a)) !== JSON.stringify(shape(b));
}
export function defaultKeys(a?: TableMeta, b?: TableMeta): string[] {
  if (!a || !b)
    return (a || b)!.columns
      .filter((c) => c.pk)
      .sort((x, y) => x.pk - y.pk)
      .map((c) => c.name);
  const keys = (t: TableMeta) =>
    t.columns
      .filter((c) => c.pk)
      .sort((x, y) => x.pk - y.pk)
      .map((c) => c.name);
  return JSON.stringify(keys(a)) === JSON.stringify(keys(b)) ? keys(a) : [];
}
export function openResults(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA cache_size=-16000; CREATE TABLE IF NOT EXISTS diffs (id INTEGER PRIMARY KEY, table_id TEXT, status TEXT, row_key TEXT, lhs TEXT, rhs TEXT, fields TEXT); CREATE INDEX IF NOT EXISTS diffs_lookup ON diffs(table_id,status,id);',
  );
  return db;
}
export async function compareTable(
  db: DatabaseSync,
  left: Driver,
  right: Driver,
  a: TableMeta | undefined,
  b: TableMeta | undefined,
  keys: string[],
  schemaOnly: boolean,
  progress: (scanned: number) => void,
): Promise<TableResult> {
  const table = (a || b)!;
  const result: TableResult = {
    id: table.id,
    name: table.name,
    left: a,
    right: b,
    schemaChanged: schemaChanged(a, b),
    added: 0,
    removed: 0,
    changed: 0,
    equal: 0,
    scanned: 0,
    state: 'done',
  };
  if (schemaOnly) return { ...result, state: 'skipped', message: 'Schema-only comparison.' };
  if (!keys.length)
    return { ...result, state: 'skipped', message: 'Choose matching columns to compare rows.' };
  if (
    keys.some(
      (k) =>
        (a && !a.columns.some((c) => c.name === k)) || (b && !b.columns.some((c) => c.name === k)),
    )
  )
    return { ...result, state: 'error', message: 'Matching columns must exist on both sides.' };
  db.exec(
    'DROP TABLE IF EXISTS lhs; DROP TABLE IF EXISTS rhs; CREATE TABLE lhs (key TEXT PRIMARY KEY, data TEXT); CREATE TABLE rhs (key TEXT PRIMARY KEY, data TEXT);',
  );
  const rowKey = (row: DataRow) => {
    if (keys.some((k) => row[k].type === 'null'))
      throw new Error('Matching columns contain NULL. Choose a non-null unique key.');
    return JSON.stringify(keys.map((k) => row[k]));
  };
  const stage = async (driver: Driver, t: TableMeta | undefined, side: 'lhs' | 'rhs') => {
    if (!t) return;
    const insert = db.prepare(`INSERT INTO ${side} VALUES (?,?)`);
    db.exec('BEGIN');
    try {
      for await (const raw of driver.rows(t)) {
        const row = normalize(raw);
        try {
          insert.run(rowKey(row), JSON.stringify(row));
        } catch (error) {
          if (String(error).includes('UNIQUE constraint'))
            throw new Error(
              `Duplicate matching key in ${side === 'lhs' ? 'source' : 'target'}. Choose columns that uniquely identify each row.`,
            );
          throw error;
        }
        result.scanned++;
        if (result.scanned % 1000 === 0) {
          db.exec('COMMIT; BEGIN');
          progress(result.scanned);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    await stage(left, a, 'lhs');
    await stage(right, b, 'rhs');
    const insert = db.prepare(
      'INSERT INTO diffs (table_id,status,row_key,lhs,rhs,fields) VALUES (?,?,?,?,?,?)',
    );
    const joined = db.prepare(
      'SELECT l.key, l.data AS lhs, r.data AS rhs FROM lhs l LEFT JOIN rhs r ON r.key=l.key UNION ALL SELECT r.key,NULL AS lhs,r.data AS rhs FROM rhs r LEFT JOIN lhs l ON l.key=r.key WHERE l.key IS NULL',
    );
    db.exec('BEGIN');
    for (const row of joined.iterate()) {
      if (row.lhs === row.rhs) {
        result.equal++;
        continue;
      }
      const lhs: DataRow | null = row.lhs ? JSON.parse(String(row.lhs)) : null,
        rhs: DataRow | null = row.rhs ? JSON.parse(String(row.rhs)) : null;
      const fields = [...new Set([...Object.keys(lhs || {}), ...Object.keys(rhs || {})])].filter(
        (k) => JSON.stringify(lhs?.[k]) !== JSON.stringify(rhs?.[k]),
      );
      const status = !lhs ? 'added' : !rhs ? 'removed' : 'changed';
      result[status]++;
      insert.run(table.id, status, row.key, row.lhs, row.rhs, JSON.stringify(fields));
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    db.prepare('DELETE FROM diffs WHERE table_id=?').run(table.id);
    result.state = 'error';
    result.message = error instanceof Error ? error.message : String(error);
    result.added = result.removed = result.changed = result.equal = 0;
  } finally {
    db.exec('DROP TABLE lhs; DROP TABLE rhs;');
  }
  return result;
}
export function getRows(
  db: DatabaseSync,
  table: string,
  page: number,
  status?: string,
): { rows: RowDiff[]; total: number } {
  const where = status ? 'table_id=? AND status=?' : 'table_id=?',
    args = status ? [table, status] : [table];
  const total = Number(
    db.prepare(`SELECT COUNT(*) AS n FROM diffs WHERE ${where}`).get(...args)!.n,
  );
  const rows = db
    .prepare(`SELECT * FROM diffs WHERE ${where} ORDER BY id LIMIT 100 OFFSET ?`)
    .all(...args, (page - 1) * 100)
    .map((r) => ({
      id: Number(r.id),
      status: r.status as RowDiff['status'],
      key: String(r.row_key),
      left: r.lhs ? JSON.parse(String(r.lhs)) : null,
      right: r.rhs ? JSON.parse(String(r.rhs)) : null,
      fields: JSON.parse(String(r.fields)),
    }));
  return { rows, total };
}
