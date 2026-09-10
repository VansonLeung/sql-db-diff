import { app, BrowserWindow, ipcMain, dialog, safeStorage, Menu } from 'electron';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { readFile, writeFile, rename, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Bookmark } from '../src/shared';
import { bookmarkSchema, endpointSchema, requestSchema } from './validation';

let window: BrowserWindow | null = null;
let startingRun = false;
let cancellationVersion = 0;
let shuttingDown = false;
let runCleanup: Promise<void> = Promise.resolve();
if (process.env.SQL_DB_DIFF_TEST_USER_DATA && !app.isPackaged)
  app.setPath('userData', process.env.SQL_DB_DIFF_TEST_USER_DATA);
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => {
  window?.show();
  window?.focus();
});
let active: { worker: Worker; id: string; dir: string; running: boolean } | undefined;
let bookmarkQueue: Promise<unknown> = Promise.resolve();
const tasks = new Set<Worker>();
const dataRoot = () => app.getPath('userData');
const vaultPath = () => join(dataRoot(), 'bookmarks.enc');
async function readBookmarks(): Promise<Bookmark[]> {
  let bytes: Buffer;
  try {
    bytes = await readFile(vaultPath());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('macOS Keychain is unavailable. Unlock your keychain and try again.');
  return z.array(bookmarkSchema).parse(JSON.parse(safeStorage.decryptString(bytes)));
}
async function writeBookmarks(bookmarks: Bookmark[]) {
  if (!safeStorage.isEncryptionAvailable())
    throw new Error('macOS Keychain is unavailable. Credentials cannot be saved.');
  await mkdir(dataRoot(), { recursive: true });
  const path = vaultPath();
  await writeFile(path + '.tmp', safeStorage.encryptString(JSON.stringify(bookmarks)), {
    mode: 0o600,
  });
  await rename(path + '.tmp', path);
}
function mutate(fn: (items: Bookmark[]) => Promise<unknown>) {
  const next = bookmarkQueue.then(async () => fn(await readBookmarks()));
  bookmarkQueue = next.catch(() => {});
  return next;
}
async function bookmark(id: string) {
  const b = (await readBookmarks()).find((b) => b.id === id);
  if (!b) throw new Error('Connection bookmark no longer exists.');
  return b;
}
function task(data: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'worker.cjs'), { workerData: data });
    tasks.add(worker);
    let settled = false;
    const timer = setTimeout(() => {
      void worker.terminate();
      reject(new Error('Operation timed out after 120 seconds.'));
    }, 120000);
    worker.on('message', (message) => {
      settled = true;
      clearTimeout(timer);
      message.error ? reject(new Error(message.error)) : resolve(message.value);
    });
    worker.on('error', reject);
    worker.on('exit', (code) => {
      clearTimeout(timer);
      tasks.delete(worker);
      if (!settled) reject(new Error(`Database worker exited (${code}).`));
    });
  });
}
function clearRun() {
  const old = active;
  active = undefined;
  runCleanup = runCleanup.then(async () => {
    if (old) {
      await old.worker.terminate();
      await rm(old.dir, { recursive: true, force: true });
    }
  });
  return runCleanup;
}
function handle(channel: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(channel, (event, ...args) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error('Untrusted IPC sender.');
    return fn(...args);
  });
}
app.whenReady().then(async () => {
  const runs = join(dataRoot(), 'comparisons');
  await rm(runs, { recursive: true, force: true });
  await mkdir(runs, { recursive: true, mode: 0o700 });
  handle('bookmarks:list', readBookmarks);
  handle('bookmarks:save', (value) =>
    mutate(async (items) => {
      const b = bookmarkSchema.parse(value);
      b.id ||= randomUUID();
      const next = items.filter((i) => i.id !== b.id);
      next.push(b);
      await writeBookmarks(next);
      return b;
    }),
  );
  handle('bookmarks:remove', (id) =>
    mutate(async (items) => {
      await writeBookmarks(items.filter((i) => i.id !== z.string().parse(id)));
    }),
  );
  handle(
    'file:choose',
    async () => (await dialog.showOpenDialog(window!, { properties: ['openFile'] })).filePaths[0],
  );
  handle('connection:test', (value) =>
    task({ action: 'databases', bookmark: bookmarkSchema.parse(value) }),
  );
  handle('databases:list', async (id) =>
    task({ action: 'databases', bookmark: await bookmark(z.string().parse(id)) }),
  );
  handle('schema:inspect', async (value) => {
    const e = endpointSchema.parse(value);
    return task({
      action: 'inspect',
      bookmark: await bookmark(e.bookmarkId),
      database: e.database,
    });
  });
  handle('compare:start', async (value) => {
    if (startingRun || active?.running)
      throw new Error('Cancel the active comparison before starting another.');
    startingRun = true;
    const version = cancellationVersion;
    try {
      const request = requestSchema.parse(value);
      const [left, right] = await Promise.all([
        bookmark(request.left.bookmarkId),
        bookmark(request.right.bookmarkId),
      ]);
      if (left.engine !== right.engine)
        throw new Error('Select two databases using the same engine.');
      await clearRun();
      const dir = await mkdtemp(join(runs, 'run-')),
        id = randomUUID();
      if (version !== cancellationVersion || shuttingDown) {
        await rm(dir, { recursive: true, force: true });
        throw new Error('Comparison cancelled.');
      }
      const worker = new Worker(join(__dirname, 'worker.cjs'), {
        workerData: {
          action: 'compare',
          request,
          left,
          right,
          path: join(dir, 'results.sqlite'),
          runId: id,
        },
      });
      active = { worker, id, dir, running: true };
      const fail = (message: string) => {
        if (active?.id === id && active.running) {
          active.running = false;
          window?.webContents.send('compare:progress', {
            runId: id,
            state: 'error',
            completed: 0,
            total: request.tables.length,
            message,
          });
        }
      };
      worker.on('message', (m) => {
        if (active?.id !== id) return;
        if (m.progress) {
          if (m.progress.state === 'done') active.running = false;
          window?.webContents.send('compare:progress', m.progress);
        }
        if (m.error) fail(m.error);
      });
      worker.on('error', (e) => fail(e.message));
      worker.on('exit', (code) => {
        if (code !== 0) fail(`Comparison worker exited (${code}).`);
      });
      return id;
    } finally {
      startingRun = false;
    }
  });
  handle('compare:cancel', async () => {
    cancellationVersion++;
    const id = active?.id;
    await clearRun();
    if (id)
      window?.webContents.send('compare:progress', {
        runId: id,
        state: 'cancelled',
        completed: 0,
        total: 0,
      });
  });
  handle('compare:rows', (table, page, status) => {
    if (!active || active.running)
      throw new Error('Results are available after the comparison finishes.');
    return task({
      action: 'rows',
      path: join(active.dir, 'results.sqlite'),
      table: z.string().parse(table),
      page: z.number().int().min(1).max(10000000).parse(page),
      status: z.enum(['added', 'removed', 'changed']).optional().parse(status),
    });
  });
  handle('demo:create', () =>
    mutate(async (items) => {
      const demos: Bookmark[] = await task({ action: 'demo', path: dataRoot() });
      const next = [...items.filter((i) => !demos.some((d) => d.id === i.id)), ...demos];
      await writeBookmarks(next);
      return next;
    }),
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ]),
  );
  const createWindow = () => {
    window = new BrowserWindow({
      width: 1480,
      height: 940,
      minWidth: 1060,
      minHeight: 720,
      title: 'SQL DB Diff',
      backgroundColor: '#f6f8fb',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 20, y: 21 },
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.on('closed', () => {
      window = null;
      cancellationVersion++;
      void clearRun();
      for (const t of tasks) void t.terminate();
    });
    if (
      !app.isPackaged &&
      process.env.VITE_DEV_SERVER_URL &&
      /^http:\/\/127\.0\.0\.1:\d+\/?$/.test(process.env.VITE_DEV_SERVER_URL)
    )
      void window.loadURL(process.env.VITE_DEV_SERVER_URL);
    else void window.loadFile(join(__dirname, '../dist/index.html'));
  };
  createWindow();
  app.on('activate', () => {
    if (!window) createWindow();
  });
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (shuttingDown) return;
  event.preventDefault();
  shuttingDown = true;
  cancellationVersion++;
  void (async () => {
    await Promise.all([...tasks].map((worker) => worker.terminate()));
    await clearRun();
    await bookmarkQueue;
  })().finally(() => app.quit());
});
