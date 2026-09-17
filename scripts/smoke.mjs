import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { build, electrobun } from './build.mjs';

const root = await mkdtemp(join(tmpdir(), 'sql-diff-native-smoke-'));
let child;
let server;
try {
  process.env.SQL_DB_DIFF_SMOKE_BUILD = '1';
  delete process.env.VITE_DEV_SERVER_URL;
  if (process.argv.includes('--dev-server')) {
    await electrobun('prepare');
    const { createServer } = await import('vite');
    server = await createServer({ mode: 'smoke' });
    await server.listen();
    process.env.VITE_DEV_SERVER_URL = server.resolvedUrls.local[0];
  }
  await build({ smoke: true });
  child = spawn(process.execPath, ['node_modules/electrobun/bin/electrobun.cjs', 'run'], {
    stdio: 'inherit',
    env: { ...process.env, SQL_DB_DIFF_TEST_USER_DATA: root },
  });
  const timer = setTimeout(() => child.kill('SIGTERM'), 110_000);
  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) =>
        code === 0 ? resolve() : reject(new Error(`Native app exited (${code ?? signal}).`)),
      );
    });
  } finally {
    clearTimeout(timer);
  }
  const result = JSON.parse(await readFile(join(root, 'smoke-result.json'), 'utf8'));
  assert.equal(result.ok, true, result.message);
  const encrypted = await readFile(join(root, 'bookmarks.enc'));
  assert.equal(encrypted.includes(Buffer.from('Edited demo source')), false);
  assert.deepEqual(await readdir(join(root, 'comparisons')), []);
  console.log(result.message);
} finally {
  child?.kill();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
