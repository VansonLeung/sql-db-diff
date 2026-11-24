import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Bookmark, ComparisonRequest, Progress } from '../src/shared';
import { DESKTOP_PROTOCOL_VERSION } from '../src/shared';
import type { BookmarkVault } from './vault';
import { bookmarkSchema, endpointSchema, requestSchema } from './validation';
import { cleanupStaleImports, createImportSession } from './imports';

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
  type Run = {
    worker?: Worker;
    controller: AbortController;
    id: string;
    dir: string;
    running: boolean;
    finished: Promise<void>;
  };
  let active: Run | undefined;
  let bookmarkQueue: Promise<unknown> = Promise.resolve();
  const tasks = new Set<Worker>();
  const readers = new Map<Worker, string>();
  const operations = new Set<AbortController>();
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
  function task(
    data: { action: string; path?: string; [key: string]: unknown },
    signal?: AbortSignal,
  ): Promise<any> {
    if (shuttingDown) return Promise.reject(new Error('Application is closing.'));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const worker = new Worker(options.workerPath, { workerData: data });
      tasks.add(worker);
      if (data.action === 'rows' && data.path) readers.set(worker, data.path);
      let settled = false;
      const abort = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().then(() => reject(new Error('Operation cancelled.')), reject);
      };
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => {
        settled = true;
        void worker
          .terminate()
          .then(() => reject(new Error('Operation timed out after 120 seconds.')), reject);
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
        signal?.removeEventListener('abort', abort);
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
          (async () => {
            old.controller.abort();
            await old.worker?.terminate();
            await old.finished;
          })(),
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
  handlers.set('app:version', () => DESKTOP_PROTOCOL_VERSION);
  function handle(channel: string, fn: (...args: any[]) => unknown) {
    handlers.set(channel, fn);
  }
  const runs = join(dataRoot(), 'comparisons');
  const imports = join(dataRoot(), 'imports');
  await cleanupStaleImports(imports);
  await rm(runs, { recursive: true, force: true });
  await mkdir(runs, { recursive: true, mode: 0o700 });
  async function sourceTask(action: 'databases' | 'inspect', b: Bookmark, database?: string) {
    const controller = new AbortController();
    operations.add(controller);
    const timer = setTimeout(() => controller.abort(), 600_000);
    let session: Awaited<ReturnType<typeof createImportSession>> | undefined;
    try {
      session = await createImportSession(imports, controller.signal);
      const prepared = await session.prepare(b, (source, path) =>
        task({ action: 'import-sqlite', source, path }, controller.signal),
      );
      if (action === 'databases' && prepared.databases) return prepared.databases;
      if (
        b.input === 'sql' &&
        b.engine !== 'sqlite' &&
        database &&
        !prepared.databases?.includes(database)
      )
        throw new Error(
          'Selected database is absent from the SQL input. Refresh databases and reload tables.',
        );
      return await task(
        {
          action,
          bookmark: prepared.bookmark,
          database: b.input === 'sql' && b.engine === 'sqlite' ? undefined : database,
        },
        controller.signal,
      );
    } finally {
      clearTimeout(timer);
      try {
        await session?.cleanup();
      } finally {
        operations.delete(controller);
      }
    }
  }

  async function runComparison(
    run: Run,
    request: ComparisonRequest,
    left: Bookmark,
    right: Bookmark,
  ) {
    let session: Awaited<ReturnType<typeof createImportSession>> | undefined;
    let complete: Progress | undefined, failure: unknown;
    try {
      session = await createImportSession(imports, run.controller.signal);
      const prepare = async (b: Bookmark, database: string, side: string) => {
        if (b.input === 'sql')
          options.onProgress({
            runId: run.id,
            state: 'running',
            completed: 0,
            total: request.tables.length,
            message: `Importing ${side} SQL ${b.sqlSource === 'text' ? 'text' : 'file'}…`,
          });
        const prepared = await session!.prepare(b, (source, path) =>
          task({ action: 'import-sqlite', source, path }, run.controller.signal),
        );
        if (b.input === 'sql' && b.engine !== 'sqlite' && !prepared.databases?.includes(database))
          throw new Error(
            'Selected database is absent from the SQL input. Refresh databases and reload tables.',
          );
        return prepared.bookmark;
      };
      const a = await prepare(left, request.left.database, 'source');
      const b = await prepare(right, request.right.database, 'target');
      run.controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const worker = new Worker(options.workerPath, {
          workerData: {
            action: 'compare',
            request,
            left: a,
            right: b,
            path: join(run.dir, 'results.sqlite'),
            runId: run.id,
          },
        });
        run.worker = worker;
        worker.on('message', (m) => {
          if (m.progress?.state === 'done') {
            complete = m.progress;
            resolve();
          } else if (m.progress && active?.id === run.id) options.onProgress(m.progress);
          if (m.error) reject(new Error(m.error));
        });
        worker.on('error', reject);
        worker.on('exit', (code) => {
          if (!complete) reject(new Error(`Comparison worker exited before completing (${code}).`));
        });
      });
    } catch (error) {
      failure = error;
    } finally {
      await run.worker?.terminate();
      try {
        await session?.cleanup();
      } catch (error) {
        failure ||= error;
      }
    }
    if (active?.id !== run.id || run.controller.signal.aborted) return;
    run.running = false;
    if (failure)
      options.onProgress({
        runId: run.id,
        state: 'error',
        completed: 0,
        total: request.tables.length,
        message: failure instanceof Error ? failure.message : String(failure),
      });
    else if (complete) options.onProgress(complete);
  }
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
  handle('connection:test', (value) => sourceTask('databases', bookmarkSchema.parse(value)));
  handle('databases:list', async (id) =>
    sourceTask('databases', await bookmark(z.string().parse(id))),
  );
  handle('schema:inspect', async (value) => {
    const e = endpointSchema.parse(value);
    return sourceTask('inspect', await bookmark(e.bookmarkId), e.database);
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
      request.schemaOnly ||= [left, right].some(
        (b) => b.input === 'sql' && b.sqlContent === 'schema',
      );
      await clearRun();
      const dir = await mkdtemp(join(runs, 'run-')),
        id = randomUUID();
      if (version !== cancellationVersion || shuttingDown) {
        await rm(dir, { recursive: true, force: true });
        throw new Error('Comparison cancelled.');
      }
      const run: Run = {
        controller: new AbortController(),
        id,
        dir,
        running: true,
        finished: Promise.resolve(),
      };
      active = run;
      run.finished = runComparison(run, request, left, right);
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
      for (const controller of operations) controller.abort();
      await Promise.all([...tasks].map((worker) => worker.terminate()));
      await Promise.allSettled([...pending]);
      await clearRun();
      await bookmarkQueue;
    },
  };
}
