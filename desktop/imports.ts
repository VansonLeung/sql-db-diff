import { spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { connect } from './drivers';
import type { Bookmark } from '../src/shared';
import { PASTED_SQL_DATABASE } from '../src/shared';

const docker = () => {
  const candidates =
    process.platform === 'win32'
      ? ['C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe']
      : ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'];
  return candidates.find((path) => existsSync(path)) || 'docker';
};

async function command(
  args: string[],
  signal?: AbortSignal,
  input?: string,
  timeout = 600_000,
  host?: string,
) {
  signal?.throwIfAborted();
  return new Promise<string>((resolve, reject) => {
    const child = spawn(docker(), host ? ['--host', host, ...args] : args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      ...(host ? { env: { ...process.env, DOCKER_CONTEXT: '' } } : {}),
    });
    let output = '',
      errors = '',
      failure: unknown;
    const abort = () => {
      failure = new Error('SQL import cancelled.');
      child.kill();
    };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => {
      failure = new Error('Docker operation timed out.');
      child.kill();
    }, timeout);
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-16000);
    });
    child.stderr.on('data', (data: Buffer) => {
      errors = (errors + data.toString()).slice(-16000);
    });
    child.on('error', (error) => {
      failure = error;
    });
    const inputDone = input
      ? pipeline(createReadStream(input), child.stdin).catch((error) => {
          failure ||= error;
          child.kill();
        })
      : Promise.resolve(child.stdin.end());
    child.on('close', async (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      await inputDone;
      if (failure || code !== 0)
        reject(
          new Error(
            `Docker SQL import: ${failure instanceof Error ? failure.message : errors.trim() || `command exited (${code})`}`,
          ),
        );
      else resolve(output.trim());
    });
  });
}

interface Resources {
  containers: string[];
  networks: string[];
  host?: string;
}
const resourceName = /^sql-db-diff-[a-f0-9-]{36}(?:-net)?$/;

async function cleanupDirectory(dir: string) {
  let resources: Resources;
  try {
    resources = JSON.parse(await readFile(join(dir, 'resources.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      await rm(dir, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  if (resources.host && !/^(unix:\/\/|npipe:\/\/)/.test(resources.host))
    throw new Error('Invalid SQL import Docker endpoint.');
  for (const name of resources.containers) {
    if (!resourceName.test(name)) throw new Error('Invalid SQL import resource record.');
    try {
      await command(['rm', '-fv', name], undefined, undefined, 15000, resources.host);
    } catch (error) {
      if (!String(error).includes('No such container')) throw error;
    }
  }
  for (const name of resources.networks) {
    if (!resourceName.test(name)) throw new Error('Invalid SQL import network record.');
    try {
      await command(['network', 'rm', name], undefined, undefined, 15000, resources.host);
    } catch (error) {
      if (!/not found|No such network/.test(String(error))) throw error;
    }
  }
  await rm(dir, { recursive: true, force: true });
}

export async function cleanupStaleImports(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  // Leave failed cleanup records for the next launch (e.g. Docker is stopped).
  await Promise.all(
    (await readdir(root))
      .filter((name) => name.startsWith('session-'))
      .map(async (name) => {
        try {
          await cleanupDirectory(join(root, name));
        } catch (error) {
          console.error('SQL import cleanup deferred:', String(error));
        }
      }),
  );
}

export async function createImportSession(root: string, signal: AbortSignal) {
  const dir = await mkdtemp(join(root, 'session-'));
  const resources: Resources = { containers: [], networks: [] };
  const record = async () => {
    await writeFile(join(dir, 'resources.next'), JSON.stringify(resources), { mode: 0o600 });
    await rename(join(dir, 'resources.next'), join(dir, 'resources.json'));
  };
  await record();
  return {
    dir,
    cleanup: () => cleanupDirectory(dir),
    async prepare(
      b: Bookmark,
      importSqlite: (source: string, destination: string) => Promise<void>,
    ): Promise<{ bookmark: Bookmark; databases?: string[] }> {
      if (b.input !== 'sql') return { bookmark: b };
      signal.throwIfAborted();
      let source: string;
      if (b.sqlSource === 'text') {
        if (!b.sqlText?.trim()) throw new Error('Paste SQL text.');
        source = join(dir, `${randomUUID()}.sql`);
        await writeFile(source, b.sqlText, { mode: 0o600 });
      } else {
        if (!b.file || !(await stat(b.file)).isFile())
          throw new Error('Choose a readable SQL file.');
        source = b.file;
      }
      signal.throwIfAborted();
      if (b.engine === 'sqlite') {
        const file = join(dir, `${randomUUID()}.sqlite`);
        await importSqlite(source, file);
        return {
          bookmark: { id: b.id, name: b.name, engine: 'sqlite', file },
          databases: [b.sqlSource === 'text' ? PASTED_SQL_DATABASE : source],
        };
      }
      const name = `sql-db-diff-${randomUUID()}`,
        network = `${name}-net`;
      const version = b.sqlVersion || (b.engine === 'postgres' ? '18' : '8.4');
      const password = randomUUID();
      const port = b.engine === 'postgres' ? 5432 : 3306;
      const image = b.engine === 'postgres' ? `postgres:${version}-alpine` : `mysql:${version}`;
      // Docker must run locally: never send SQL dumps to a remote Docker context.
      const context = await command(
        ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'],
        signal,
        undefined,
        15000,
      );
      const host = process.env.DOCKER_CONTEXT ? context : process.env.DOCKER_HOST || context;
      if (!/^(unix:\/\/|npipe:\/\/)/.test(host))
        throw new Error(
          'SQL import requires a local Docker context (Unix socket or Windows named pipe).',
        );
      resources.host = host;
      resources.containers.push(name);
      resources.networks.push(network);
      await record(); // Persist before starting external resources, including for crash recovery.
      const run = (args: string[], input?: string, timeout?: number) =>
        command(args, signal, input, timeout, host);
      // Let resource-creation requests finish before cancellation cleanup, so
      // Docker cannot create a container after we have already tried to remove it.
      const createResource = async (args: string[]) => {
        signal.throwIfAborted();
        await command(args, undefined, undefined, 15000, host);
        signal.throwIfAborted();
      };
      try {
        await run(['image', 'inspect', image], undefined, 15000);
      } catch {
        signal.throwIfAborted();
        await run(['pull', image]);
      }
      await createResource(['network', 'create', network]);
      const env =
        b.engine === 'postgres'
          ? ['-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=sqldiff']
          : [
              '-e',
              `MYSQL_ROOT_PASSWORD=${password}`,
              '-e',
              'MYSQL_DATABASE=sqldiff',
              '-e',
              'MYSQL_ROOT_HOST=%',
            ];
      await createResource([
        'create',
        '--name',
        name,
        '--network',
        network,
        '--publish',
        `127.0.0.1::${port}`,
        ...env,
        image,
      ]);
      await createResource(['start', name]);
      const deadline = Date.now() + 180_000;
      while (true) {
        signal.throwIfAborted();
        try {
          await run(
            b.engine === 'postgres'
              ? ['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'sqldiff', '-h', '127.0.0.1']
              : [
                  'exec',
                  '-e',
                  `MYSQL_PWD=${password}`,
                  name,
                  'mysql',
                  '--protocol=TCP',
                  '-h127.0.0.1',
                  '-uroot',
                  '-Nse',
                  'SELECT 1',
                ],
            undefined,
            10000,
          );
          break;
        } catch (error) {
          if (Date.now() > deadline)
            throw new Error(`Temporary ${b.engine} server did not become ready: ${String(error)}`);
          await pause(500, undefined, { signal });
        }
      }
      const address = await run(['port', name, `${port}/tcp`]);
      const published = /^127\.0\.0\.1:(\d+)$/.exec(address);
      if (!published)
        throw new Error('Docker did not publish the temporary database on localhost.');
      try {
        await run(
          b.engine === 'postgres'
            ? [
                'exec',
                '-i',
                name,
                'psql',
                '-X',
                '-v',
                'ON_ERROR_STOP=1',
                '-U',
                'postgres',
                '-d',
                'sqldiff',
              ]
            : [
                'exec',
                '-i',
                '-e',
                `MYSQL_PWD=${password}`,
                name,
                'mysql',
                '--binary-mode',
                '--local-infile=0',
                '-uroot',
                'sqldiff',
              ],
          source,
        );
      } catch (error) {
        throw new Error(
          `SQL input could not be restored as ${b.engine} ${version}. Supply a standalone plain SQL dump; required roles/extensions and migration/data-only scripts needing a base schema are not supplied automatically. ${String(error)}`,
        );
      }
      signal.throwIfAborted();
      const imported: Bookmark = {
        id: b.id,
        name: b.name,
        engine: b.engine,
        host: '127.0.0.1',
        port: Number(published[1]),
        user: b.engine === 'postgres' ? 'postgres' : 'root',
        password,
        database: 'sqldiff',
      };
      const driver = await connect(imported);
      let candidates: string[];
      try {
        candidates = (await driver.databases()).filter(
          (db) => !['mysql', 'sys', 'performance_schema', 'information_schema'].includes(db),
        );
      } finally {
        await driver.close();
      }
      const databases: string[] = [];
      for (const database of candidates) {
        signal.throwIfAborted();
        const d = await connect(imported, database);
        try {
          if ((await d.inspect()).length) databases.push(database);
        } finally {
          await d.close();
        }
      }
      if (!databases.length)
        throw new Error(
          'SQL import created no tables. Supply a complete schema or schema-and-data dump.',
        );
      imported.database = databases.includes(b.database || '') ? b.database : databases[0];
      return { bookmark: imported, databases };
    },
  };
}
