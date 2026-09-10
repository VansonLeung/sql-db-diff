import { build } from 'esbuild';
await build({
  entryPoints: ['electron/main.ts', 'electron/preload.ts', 'electron/worker.ts'],
  outdir: 'dist-electron',
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  packages: 'external',
});
