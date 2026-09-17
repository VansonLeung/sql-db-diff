import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import type { Bookmark } from '../src/shared';
import { bookmarkSchema } from './validation';

const magic = Buffer.from('SQLDIFF2');
export interface KeyStore {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
}

export function systemKeyStore(dataRoot: string): KeyStore {
  const entry = {
    service: 'com.sqldbdiff.desktop',
    name: `vault-${createHash('sha256').update(resolve(dataRoot)).digest('hex')}`,
  };
  return {
    get: () => Bun.secrets.get(entry),
    set: (value) => Bun.secrets.set({ ...entry, value }),
  };
}

// Store only the small encryption key in the OS credential store; bookmarks can
// contain certificates/SSH keys larger than Windows Credential Manager permits.
export class BookmarkVault {
  private keyPromise?: Promise<Buffer>;
  constructor(
    private root: string,
    private keys: KeyStore = systemKeyStore(root),
  ) {}

  private key(create: boolean): Promise<Buffer> {
    return (this.keyPromise ??= (async () => {
      let encoded = await this.keys.get();
      if (!encoded) {
        if (!create)
          throw new Error('The bookmark encryption key is missing from the OS credential store.');
        encoded = randomBytes(32).toString('base64');
        await this.keys.set(encoded);
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== 32) throw new Error('Invalid bookmark encryption key.');
      return key;
    })().catch((cause) => {
      this.keyPromise = undefined;
      throw new Error(
        'Cannot access encrypted bookmarks. Unlock the OS credential store and try again.',
        { cause },
      );
    }));
  }

  async read(): Promise<Bookmark[]> {
    let bytes: Buffer;
    try {
      bytes = await readFile(join(this.root, 'bookmarks.enc'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (bytes.length < 36 || !bytes.subarray(0, 8).equals(magic)) {
      throw new Error(
        'Unsupported bookmark format. Legacy Electron bookmarks must be re-entered; the original file has been preserved.',
      );
    }
    const decipher = createDecipheriv('aes-256-gcm', await this.key(false), bytes.subarray(8, 20));
    decipher.setAAD(magic);
    decipher.setAuthTag(bytes.subarray(20, 36));
    const text = Buffer.concat([decipher.update(bytes.subarray(36)), decipher.final()]).toString(
      'utf8',
    );
    return z.array(bookmarkSchema).parse(JSON.parse(text));
  }

  async write(items: Bookmark[]): Promise<void> {
    const validated = z.array(bookmarkSchema).parse(items);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', await this.key(true), iv);
    cipher.setAAD(magic);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(validated)), cipher.final()]);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const path = join(this.root, 'bookmarks.enc');
    await writeFile(path + '.tmp', Buffer.concat([magic, iv, cipher.getAuthTag(), encrypted]), {
      mode: 0o600,
    });
    await rename(path + '.tmp', path);
  }
}
