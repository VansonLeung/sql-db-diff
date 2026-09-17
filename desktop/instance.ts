import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Acquire before accessing the vault or cleaning comparison files. An existing
// process must never have its data/temporary databases removed by a second launch.
export async function acquireInstance(root: string): Promise<() => Promise<void>> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'instance.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(lock, { mode: 0o700 });
      await writeFile(join(lock, 'pid'), String(process.pid), { mode: 0o600 });
      return () => rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let pid: number;
      try {
        pid = Number(await readFile(join(lock, 'pid'), 'utf8'));
      } catch {
        throw new Error('SQL DB Diff is starting in another process. Try again shortly.');
      }
      if (!Number.isSafeInteger(pid) || pid <= 0)
        throw new Error('Invalid application instance lock.');
      try {
        process.kill(pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      throw new Error('SQL DB Diff is already running.');
    }
  }
  throw new Error('Could not acquire the application instance lock.');
}
