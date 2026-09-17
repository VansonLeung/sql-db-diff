import type { ElectrobunConfig } from 'electrobun';

export default {
  app: {
    name: 'SQL DB Diff',
    identifier: 'com.sqldbdiff.desktop',
    version: '0.1.0',
  },
  build: {
    buildFolder: process.env.SQL_DB_DIFF_SMOKE_BUILD === '1' ? 'build/smoke' : 'build',
    artifactFolder: process.env.SQL_DB_DIFF_SMOKE_BUILD === '1' ? 'artifacts/smoke' : 'artifacts',
    mainProcess: 'bun',
    bun: { entrypoint: 'desktop/main.ts' },
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
      'dist-desktop/worker.js': 'bun/worker.js',
    },
    watchIgnore: ['dist/**', 'dist-desktop/**', 'build/**', 'artifacts/**'],
    mac: { bundleCEF: false, bundleWGPU: false },
    win: { bundleCEF: false, bundleWGPU: false },
    linux: { bundleCEF: false, bundleWGPU: false },
  },
  runtime: {
    exitOnLastWindowClosed: false,
    smokeTest: process.env.SQL_DB_DIFF_SMOKE_BUILD === '1',
    devServerURL: process.env.VITE_DEV_SERVER_URL || null,
  },
} satisfies ElectrobunConfig;
