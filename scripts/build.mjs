import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.on('error', reject);
    child.on('exit', (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`${command} failed (${code ?? signal}).`)),
    );
  });
}
export const bin = (name) => {
  if (name !== 'bun') throw new Error('Only the pinned Bun executable is supported here.');
  return fileURLToPath(new URL('../node_modules/bun/bin/bun.exe', import.meta.url));
};
// Use Node entrypoints so Windows builds do not need to execute .cmd shims.
export const electrobun = (...args) =>
  run(process.execPath, ['node_modules/electrobun/bin/electrobun.cjs', ...args]);

export async function build({ release = false, smoke = false } = {}) {
  if (release) {
    delete process.env.VITE_DEV_SERVER_URL;
    delete process.env.SQL_DB_DIFF_SMOKE_BUILD;
    smoke = false;
  }
  await electrobun('prepare');
  await run(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit']);
  await run(process.execPath, [
    'node_modules/vite/bin/vite.js',
    'build',
    ...(smoke ? ['--mode', 'smoke'] : []),
  ]);
  await run(bin('bun'), [
    'build',
    'desktop/worker.ts',
    '--target=bun',
    '--outdir=dist-desktop',
    '--external=pg-native',
    '--external=cpu-features',
    '--external=*.node',
    '--minify',
  ]);
  await electrobun('build', `--env=${release ? 'stable' : 'dev'}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const platform = process.argv.find((arg) => arg.startsWith('--platform='))?.split('=')[1];
  if (platform && platform !== process.platform)
    throw new Error(
      `Build this installer on ${platform}; Electrobun packages for the host OS. Use the matching CI runner.`,
    );
  await build({
    release: process.argv.includes('--release'),
    smoke: process.env.SQL_DB_DIFF_SMOKE_BUILD === '1',
  });
}
