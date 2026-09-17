import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import mysql from 'mysql2/promise';
import { connect, connectionOptions } from '../desktop/drivers';
import { compareTable, openResults, defaultKeys, getRows } from '../desktop/diff';
import type { Bookmark } from '../src/shared';

for (const engine of ['postgres', 'mysql'] as const)
  test(
    `${engine}: real server snapshots, schema discovery, precision and row diffs`,
    { skip: !process.env.TEST_DATABASE_SERVERS },
    async () => {
      const base: Bookmark = {
        id: engine,
        name: engine,
        engine,
        host: '127.0.0.1',
        port: engine === 'postgres' ? 55439 : 53369,
        user: engine === 'postgres' ? 'postgres' : 'root',
        password: 'diff-test-only',
      };
      const exec =
        engine === 'postgres'
          ? await (async () => {
              const c = new pg.Client({ ...base, database: 'postgres' });
              await c.connect();
              return { query: (s: string) => c.query(s), close: () => c.end() };
            })()
          : await (async () => {
              const c = await mysql.createConnection(connectionOptions(base));
              return { query: (s: string) => c.query(s), close: () => c.end() };
            })();
      try {
        for (const name of ['diff_source', 'diff_target']) {
          await exec.query(`DROP DATABASE IF EXISTS ${name}`);
          await exec.query(`CREATE DATABASE ${name}`);
        }
      } finally {
        await exec.close();
      }
      for (const name of ['diff_source', 'diff_target']) {
        const c =
          engine === 'postgres'
            ? await (async () => {
                const c = new pg.Client({ ...base, database: name });
                await c.connect();
                return { query: (s: string) => c.query(s), close: () => c.end() };
              })()
            : await (async () => {
                const c = await mysql.createConnection(connectionOptions(base, name));
                return { query: (s: string) => c.query(s), close: () => c.end() };
              })();
        try {
          await c.query(
            'CREATE TABLE accounts (tenant INTEGER NOT NULL, id BIGINT NOT NULL, amount DECIMAL(30,8), label VARCHAR(80), PRIMARY KEY(tenant,id))',
          );
          await c.query('CREATE INDEX accounts_label ON accounts(label)');
          await c.query(
            "INSERT INTO accounts VALUES (1,9223372036854775807,12345678901234567890.12345678,'original'),(1,2,NULL,'same')",
          );
          if (name === 'diff_target') {
            await c.query("UPDATE accounts SET label='changed' WHERE id=9223372036854775807");
            await c.query("INSERT INTO accounts VALUES (1,3,1.0,'added')");
          }
        } finally {
          await c.close();
        }
      }
      const dir = await mkdtemp(join(tmpdir(), 'sqldiff-network-'));
      const l = await connect(base, 'diff_source'),
        r = await connect(base, 'diff_target'),
        db = openResults(join(dir, 'r.db'));
      try {
        const at = (await l.inspect())[0],
          bt = (await r.inspect())[0];
        assert.deepEqual(defaultKeys(at, bt), ['tenant', 'id']);
        assert.ok(at.indexes.some((s) => s.includes('accounts_label')));
        assert.ok(at.constraints.length);
        const result = await compareTable(db, l, r, at, bt, defaultKeys(at, bt), false, () => {});
        assert.equal(result.state, 'done');
        assert.equal(result.schemaChanged, false);
        assert.deepEqual(
          [result.added, result.removed, result.changed, result.equal],
          [1, 0, 1, 1],
        );
        const row = getRows(db, at.id, 1, 'changed').rows[0];
        assert.equal(row.left?.id.value, '9223372036854775807');
        assert.equal(row.left?.amount.value, '12345678901234567890.12345678');
        assert.ok((await l.databases()).includes('diff_target'));
        await assert.rejects(l.query('DELETE FROM accounts'), /read.only/i);
      } finally {
        db.close();
        await l.close();
        await r.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
