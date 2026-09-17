import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Bookmark, Progress } from '../src/shared';
import type { BookmarkVault } from './vault';
import { bookmarkSchema, endpointSchema, requestSchema } from './validation';

export async function createService(options: {
  dataRoot: string;
  workerPath: string;
  vault: BookmarkVault;
  chooseFile: () => Promise<string | undefined>;
  onProgress: (progress: Progress) => void;
}) {
  let startingRun = false;
  let cancellationVersion = 0;
  let shuttingDown = false;
  let runCleanup: Promise<void> = Promise.resolve();
  let active: { worker: Worker; id: string; dir: string; running: boolean } | undefined;
  let bookmarkQueue: Promise<unknown> = Promise.resolve();
  const tasks = new Set<Worker>();
  const readers = new Map<Worker, string>();
  const dataRoot = () => options.dataRoot;
  const readBookmarks = () => options.vault.read();
  const writeBookmarks = (items: Bookmark[]) => options.vault.write(items);
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
  function task(data: { action: string; path?: string; [key: string]: unknown }): Promise<any> {
    if (shuttingDown) return Promise.reject(new Error('Application is closing.'));
    return new Promise((resolve, reject) => {
      const worker = new Worker(options.workerPath, { workerData: data });
      tasks.add(worker);
      if (data.action === 'rows' && data.path) readers.set(worker, data.path);
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
      worker.on('error', (error) => {
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      worker.on('exit', (code) => {
        clearTimeout(timer);
        tasks.delete(worker);
        readers.delete(worker);
        if (!settled) reject(new Error(`Database worker exited (${code}).`));
      });
    });
  }
  function clearRun() {
    const old = active;
    active = undefined;
    runCleanup = runCleanup.then(async () => {
      if (old) {
        const resultPath = join(old.dir, 'results.sqlite');
        await Promise.all([
          old.worker.terminate(),
          ...[...readers]
            .filter(([, path]) => path === resultPath)
            .map(([worker]) => worker.terminate()),
        ]);
        await rm(old.dir, { recursive: true, force: true });
      }
    });
    return runCleanup;
  }

  const handlers = new Map<string, (...args: any[]) => unknown>();
  function handle(channel: string, fn: (...args: any[]) => unknown) {
    handlers.set(channel, fn);
  }
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
  handle('file:choose', options.chooseFile);
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
      const worker = new Worker(options.workerPath, {
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
          options.onProgress({
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
          options.onProgress(m.progress);
        }
        if (m.error) fail(m.error);
      });
      worker.on('error', (e) => fail(e.message));
      worker.on('exit', (code) => {
        fail(`Comparison worker exited before completing (${code}).`);
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
      options.onProgress({
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

  const pending = new Set<Promise<unknown>>();
  return {
    async invoke(method: string, args: unknown[]) {
      if (shuttingDown) throw new Error('Application is closing.');
      const handler = handlers.get(method);
      if (!handler || !Array.isArray(args)) throw new Error('Unknown desktop request.');
      const request = Promise.resolve().then(() => handler(...args));
      pending.add(request);
      try {
        return await request;
      } finally {
        pending.delete(request);
      }
    },
    async close() {
      shuttingDown = true;
      cancellationVersion++;
      await Promise.all([...tasks].map((worker) => worker.terminate()));
      await Promise.allSettled([...pending]);
      await clearRun();
      await bookmarkQueue;
    },
  };
}
