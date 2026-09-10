import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from '../electron/drivers';
import { compareTable, openResults } from '../electron/diff';
const dir = await mkdtemp(join(tmpdir(), 'sql-diff-bench-'));
const started = performance.now();
let peak = 0;
try {
  for (const side of ['a', 'b']) {
    const db = new DatabaseSync(join(dir, side + '.db'));
    db.exec('BEGIN');
    for (let i = 0; i < 200; i++)
      db.exec(
        `CREATE TABLE t${i} (id INTEGER PRIMARY KEY, value TEXT); WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<50000) INSERT INTO t${i} SELECT x,'value-'||x FROM n;`,
      );
    if (side === 'b')
      for (let i = 0; i < 200; i++) db.exec(`UPDATE t${i} SET value='changed' WHERE id=1`);
    db.exec('COMMIT');
    db.close();
  }
  const l = await connect({ id: 'a', name: 'a', engine: 'sqlite', file: join(dir, 'a.db') }),
    r = await connect({ id: 'b', name: 'b', engine: 'sqlite', file: join(dir, 'b.db') }),
    out = openResults(join(dir, 'out.db'));
  const comparisonStart = performance.now();
  try {
    const a = await l.inspect(),
      b = await r.inspect();
    for (let i = 0; i < a.length; i++) {
      const result = await compareTable(out, l, r, a[i], b[i], ['id'], false, () => {
        peak = Math.max(peak, process.memoryUsage().rss);
      });
      if (result.changed !== 1 || result.equal !== 49999) throw new Error(JSON.stringify(result));
      if ((i + 1) % 25 === 0) console.log(`${i + 1}/200 tables verified`);
    }
    console.log(
      JSON.stringify({
        tables: 200,
        rowsPerTable: 50000,
        rowsRead: 20000000,
        comparisonSeconds: ((performance.now() - comparisonStart) / 1000).toFixed(1),
        totalSeconds: ((performance.now() - started) / 1000).toFixed(1),
        peakRssMiB: Math.round(peak / 1024 / 1024),
      }),
    );
  } finally {
    out.close();
    await l.close();
    await r.close();
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
