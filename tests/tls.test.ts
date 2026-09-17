import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { connect } from '../desktop/drivers';
const exec = promisify(execFile);
test(
  'TLS verifies custom CA, client certificates, hostname and rejects untrusted certificates on both engines',
  { skip: !process.env.TEST_TLS_DATABASE_SERVERS },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sqldiff-tls-'));
    try {
      const cert = join(dir, 'cert.pem'),
        key = join(dir, 'key.pem');
      await exec('openssl', [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
      ]);
      for (const engine of ['pg', 'mysql']) {
        const container = `sql-db-diff-test-${engine}`;
        await exec('docker', ['cp', cert, `${container}:/tmp/sqldiff-cert.pem`]);
        await exec('docker', ['cp', key, `${container}:/tmp/sqldiff-key.pem`]);
        await exec('docker', [
          'exec',
          container,
          'chown',
          engine === 'pg' ? 'postgres:postgres' : 'mysql:mysql',
          '/tmp/sqldiff-key.pem',
        ]);
        await exec('docker', ['exec', container, 'chmod', '600', '/tmp/sqldiff-key.pem']);
      }
      for (const sql of [
        "ALTER SYSTEM SET ssl_cert_file='/tmp/sqldiff-cert.pem'",
        "ALTER SYSTEM SET ssl_key_file='/tmp/sqldiff-key.pem'",
        "ALTER SYSTEM SET ssl_ca_file='/tmp/sqldiff-cert.pem'",
        'ALTER SYSTEM SET ssl=on',
        'SELECT pg_reload_conf()',
      ])
        await exec('docker', ['exec', 'sql-db-diff-test-pg', 'psql', '-U', 'postgres', '-c', sql]);
      await exec('docker', [
        'exec',
        'sql-db-diff-test-mysql',
        'mysql',
        '-uroot',
        '-pdiff-test-only',
        '-e',
        "SET GLOBAL ssl_ca='/tmp/sqldiff-cert.pem'; SET GLOBAL ssl_cert='/tmp/sqldiff-cert.pem'; SET GLOBAL ssl_key='/tmp/sqldiff-key.pem'; ALTER INSTANCE RELOAD TLS;",
      ]);
      const ca = await readFile(cert, 'utf8'),
        privateKey = await readFile(key, 'utf8');
      for (const engine of ['postgres', 'mysql'] as const) {
        const b = {
          id: engine,
          name: engine,
          engine,
          host: 'localhost',
          port: engine === 'postgres' ? 55439 : 53369,
          user: engine === 'postgres' ? 'postgres' : 'root',
          password: 'diff-test-only',
          ssl: { enabled: true, ca, cert: ca, key: privateKey },
        };
        const driver = await connect(b);
        try {
          assert.ok((await driver.databases()).length);
          const rows = await driver.query(
            engine === 'postgres'
              ? 'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()'
              : "SHOW SESSION STATUS LIKE 'Ssl_cipher'",
          );
          assert.ok(engine === 'postgres' ? rows[0].ssl === 't' : rows[0].Value);
        } finally {
          await driver.close();
        }
        await assert.rejects(connect({ ...b, ssl: { enabled: true } }), /self.signed|certificate/i);
        await assert.rejects(connect({ ...b, host: '127.0.0.1' }), /hostname|DNS|certificate|IP/i);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
