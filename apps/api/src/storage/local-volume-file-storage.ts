import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, constants, lstat, mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ConfigError } from '../config/app-config.js';
import {
  type FileStorage,
  InvalidStorageKeyError,
  isOriginalObjectKey,
  StorageObjectNotFoundError,
} from './file-storage.js';

/** Temporaries live inside the root (same filesystem, so rename is atomic) but outside the key space. */
const TMP_DIR = '.tmp';

function isErrno(err: unknown, ...codes: string[]): boolean {
  return typeof err === 'object' && err !== null && codes.includes((err as NodeJS.ErrnoException).code ?? '');
}

function isInside(root: string, candidate: string): boolean {
  return candidate.startsWith(root + path.sep);
}

/** Sole FileStorage implementation: originals as plain files below one canonical root directory. */
export class LocalVolumeFileStorage implements FileStorage {
  private constructor(private readonly root: string) {}

  /**
   * Verifies the directory exists and is writable and returns the storage. Failures are ConfigErrors that name the
   * variable only, never the supplied path.
   */
  static async open(dir: string | undefined): Promise<LocalVolumeFileStorage> {
    const fail = (reason: string): never => {
      throw new ConfigError([{ variable: 'FILE_STORAGE_DIR', reason }]);
    };
    if (dir === undefined) return fail('is required');
    let root: string;
    try {
      root = await realpath(path.resolve(dir));
      if (!(await stat(root)).isDirectory()) return fail('must be an existing directory');
    } catch (err) {
      if (err instanceof ConfigError) throw err;
      return fail('must be an existing directory');
    }
    try {
      await access(root, constants.R_OK | constants.W_OK | constants.X_OK);
      await mkdir(path.join(root, TMP_DIR), { recursive: true, mode: 0o700 });
    } catch {
      return fail('must be a writable directory');
    }
    return new LocalVolumeFileStorage(root);
  }

  /**
   * Validates the key shape, resolves it below the root and rejects symlink escapes: the deepest existing ancestor
   * must resolve (through symlinks) to a path inside the canonical root, and the object itself must not be a symlink.
   */
  private async resolve(key: string): Promise<string> {
    if (!isOriginalObjectKey(key)) throw new InvalidStorageKeyError();
    const target = path.resolve(this.root, ...key.split('/'));
    if (!isInside(this.root, target)) throw new InvalidStorageKeyError();

    let existing = target;
    for (;;) {
      try {
        const info = await lstat(existing);
        if (info.isSymbolicLink()) throw new InvalidStorageKeyError();
        break;
      } catch (err) {
        if (err instanceof InvalidStorageKeyError) throw err;
        if (!isErrno(err, 'ENOENT')) throw new InvalidStorageKeyError();
        const parent = path.dirname(existing);
        if (parent === existing) throw new InvalidStorageKeyError();
        existing = parent;
      }
    }
    const real = await realpath(existing);
    if (real !== this.root && !isInside(this.root, real)) throw new InvalidStorageKeyError();
    return target;
  }

  async put(key: string, stream: Readable): Promise<{ size: number }> {
    const target = await this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    // Re-check after creating directories, so a link planted meanwhile is caught before anything is written.
    await this.resolve(key);

    const tmp = path.join(this.root, TMP_DIR, `${randomUUID()}.part`);
    let size = 0;
    stream.on('data', (chunk: Buffer) => {
      size += chunk.length;
    });
    try {
      await pipeline(stream, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
      await rename(tmp, target);
    } catch (err) {
      await unlink(tmp).catch(() => undefined);
      throw err;
    }
    return { size };
  }

  async get(key: string): Promise<Readable> {
    const target = await this.resolve(key);
    try {
      if (!(await stat(target)).isFile()) throw new StorageObjectNotFoundError();
    } catch (err) {
      if (isErrno(err, 'ENOENT')) throw new StorageObjectNotFoundError();
      throw err;
    }
    return createReadStream(target);
  }

  async exists(key: string): Promise<boolean> {
    const target = await this.resolve(key);
    try {
      return (await stat(target)).isFile();
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const target = await this.resolve(key);
    try {
      await unlink(target);
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err;
    }
  }
}
