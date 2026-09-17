import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createConnection } from 'node:net';
import { execFileSync } from 'node:child_process';
import ssh2 from 'ssh2';
const { Server, utils } = ssh2;
import { connect } from '../desktop/drivers';
import type { Bookmark } from '../src/shared';
test(
  'SSH password/private-key tunnels reach PostgreSQL and MySQL and reject wrong host fingerprints',
  { skip: !process.env.TEST_DATABASE_SERVERS },
  async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const host = utils.parseKey(privateKey);
    if (host instanceof Error) throw host;
    const fingerprint =
      'SHA256:' +
      createHash('sha256').update(host.getPublicSSH()).digest('base64').replace(/=+$/, '');
    const server = new Server({ hostKeys: [privateKey] }, (client) => {
      client.on('error', () => {});
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === 'tunnel-test') ctx.accept();
        else if (
          ctx.method === 'publickey' &&
          ctx.key.data.equals(host.getPublicSSH()) &&
          (!ctx.signature || host.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true)
        )
          ctx.accept();
        else ctx.reject();
      });
      client.on('ready', () =>
        client.on('tcpip', (accept, reject, info) => {
          const socket = createConnection({ host: info.destIP, port: info.destPort });
          socket.once('connect', () => {
            const stream = accept();
            stream.on('error', () => socket.destroy());
            socket.on('error', () => stream.destroy());
            socket.pipe(stream).pipe(socket);
          });
          socket.once('error', () => reject());
        }),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as import('node:net').AddressInfo).port;
    try {
      for (const engine of ['postgres', 'mysql'] as const) {
        for (const auth of ['password', 'key']) {
          const b: Bookmark = {
            id: 't',
            name: 't',
            engine,
            host: process.env.TEST_SSH_TLS ? 'localhost' : '127.0.0.1',
            port: engine === 'postgres' ? 55439 : 53369,
            user: engine === 'postgres' ? 'postgres' : 'root',
            password: 'diff-test-only',
            ...(process.env.TEST_SSH_TLS
              ? {
                  ssl: {
                    enabled: true,
                    ca: execFileSync(
                      'docker',
                      [
                        'exec',
                        `sql-db-diff-test-${engine === 'postgres' ? 'pg' : 'mysql'}`,
                        'cat',
                        '/tmp/sqldiff-cert.pem',
                      ],
                      { encoding: 'utf8' },
                    ),
                  },
                }
              : {}),
            ssh: {
              enabled: true,
              host: '127.0.0.1',
              port,
              user: 'test',
              fingerprint,
              ...(auth === 'password' ? { password: 'tunnel-test' } : { privateKey }),
            },
          };
          const driver = await connect(b);
          try {
            assert.ok((await driver.databases()).length > 0);
          } finally {
            await driver.close();
          }
          if (auth === 'password')
            await assert.rejects(
              connect({ ...b, ssh: { ...b.ssh!, fingerprint: 'SHA256:untrusted' } }),
              /verification/i,
            );
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
);
