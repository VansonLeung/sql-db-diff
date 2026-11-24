import Electrobun, {
  ApplicationMenu,
  BrowserView,
  BrowserWindow,
  BuildConfig,
  PATHS,
  Utils,
} from 'electrobun/main';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import type { DesktopRPC } from '../src/rpc';
import { createService } from './service';
import { BookmarkVault } from './vault';
import { acquireInstance } from './instance';

async function main() {
  const config = BuildConfig.getSync();
  const smoke = config.runtime?.smokeTest === true;
  const testRoot = smoke ? process.env.SQL_DB_DIFF_TEST_USER_DATA : undefined;
  if (smoke && !testRoot) throw new Error('Smoke builds require an isolated test data directory.');
  const dataRoot = testRoot || Utils.paths.userData;
  const releaseInstance = await acquireInstance(dataRoot);
  // Only smoke builds use an ephemeral key. Normal builds always use OS secrets.
  let testKey: string | null = null;
  const vault = new BookmarkVault(
    dataRoot,
    smoke
      ? {
          get: async () => testKey,
          set: async (value) => {
            testKey = value;
          },
        }
      : undefined,
  );
  let service: Awaited<ReturnType<typeof createService>>;
  let closing: Promise<void> | undefined;
  let closed = false;
  let exitCode = 0;
  const shutdown = () =>
    (closing ??= (async () => {
      try {
        await service?.close();
      } finally {
        await releaseInstance();
        closed = true;
        Utils.quit(exitCode);
      }
    })());

  Electrobun.events.on('before-quit', (event) => {
    if (!closed) {
      event.response = { allow: false };
      void shutdown();
    }
  });

  const rpc = BrowserView.defineRPC<DesktopRPC>({
    maxRequestTime: 660_000,
    handlers: {
      requests: {
        _: (method, args) => service.invoke(method, args as unknown[]),
        'smoke:sql-fixture': () => {
          if (!smoke) throw new Error('Smoke fixtures are disabled.');
          return process.env.SQL_DB_DIFF_SMOKE_SQL_FILE;
        },
        'smoke:report': async (value) => {
          if (!smoke) throw new Error('Smoke reporting is disabled.');
          const result = z.object({ ok: z.boolean(), message: z.string().max(10000) }).parse(value);
          // Verify the real backend's encrypted persistence before reporting success.
          if (result.ok) {
            const bookmarks = await vault.read();
            if (!bookmarks.some((item) => item.name === 'Edited demo source')) {
              result.ok = false;
              result.message = 'Edited bookmark did not persist.';
            }
          }
          await writeFile(join(dataRoot, 'smoke-result.json'), JSON.stringify(result));
          console.log(`Native smoke: ${result.ok ? 'PASS' : 'FAIL'}: ${result.message}`);
          exitCode = result.ok ? 0 : 1;
          setTimeout(() => {
            void shutdown();
          }, 100);
        },
      },
      messages: {},
    },
  });

  try {
    service = await createService({
      dataRoot,
      workerPath: join(PATHS.RESOURCES_FOLDER, 'app/bun/worker.js'),
      vault,
      chooseFile: async () =>
        smoke
          ? join(dataRoot, 'smoke-input.sql')
          : (
              await Utils.openFileDialog({
                canChooseFiles: true,
                canChooseDirectory: false,
                allowsMultipleSelection: false,
              })
            )[0],
      onProgress: (progress) => {
        if (!closing) rpc.send.progress(progress);
      },
    });
    if (smoke)
      await writeFile(
        join(dataRoot, 'smoke-input.sql'),
        "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, plan TEXT DEFAULT 'starter'); INSERT INTO customers VALUES(1,'Ada Chen','ada@example.test','pro');",
      );
    ApplicationMenu.setApplicationMenu([
      {
        label: 'SQL DB Diff',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'quit', accelerator: 'CommandOrControl+Q' },
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'selectAll' },
        ],
      },
      { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'close' }] },
    ]);
    const devURL = config.runtime?.devServerURL;
    const url =
      !config.isPackaged &&
      typeof devURL === 'string' &&
      /^http:\/\/127\.0\.0\.1:\d+\/$/.test(devURL)
        ? devURL
        : 'views://mainview/index.html';
    const window = new BrowserWindow({
      title: 'SQL DB Diff',
      frame: { width: 1480, height: 940, x: 80, y: 60 },
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      trafficLightOffset: { x: 20, y: 21 },
      renderer: 'native',
      url,
      rpc,
      navigationRules: JSON.stringify(['^*', url]),
    });
    window.on('close', () => {
      void shutdown();
    });
    if (smoke)
      setTimeout(() => {
        exitCode = 1;
        console.error('Native smoke test timed out.');
        void shutdown();
      }, 90_000).unref();
  } catch (error) {
    console.error(error);
    exitCode = 1;
    await shutdown();
  }
}

void main().catch(async (error) => {
  console.error(error);
  try {
    await Utils.showMessageBox({
      type: 'error',
      title: 'SQL DB Diff',
      message: error instanceof Error ? error.message : String(error),
    });
  } finally {
    Utils.quit(1);
  }
});
