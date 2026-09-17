import { spawn } from 'node:child_process';
import { electrobun, build } from './build.mjs';

await electrobun('prepare');
const { createServer } = await import('vite');
const server = await createServer();
await server.listen();
process.env.VITE_DEV_SERVER_URL = server.resolvedUrls.local[0];
try {
  await build();
  const child = spawn(process.execPath, ['node_modules/electrobun/bin/electrobun.cjs', 'run'], {
    stdio: 'inherit',
    env: process.env,
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      process.exitCode = code ?? 0;
      resolve();
    });
  });
} finally {
  await server.close();
}
