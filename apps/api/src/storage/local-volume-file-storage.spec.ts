import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigError } from '../config/app-config.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';
import { InvalidStorageKeyError, originalObjectKey, StorageObjectNotFoundError } from './file-storage.js';
import { LocalVolumeFileStorage } from './local-volume-file-storage.js';

async function read(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let base: string;
let root: string;
let outside: string;
let storage: LocalVolumeFileStorage;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'seshat-storage-'));
  root = path.join(base, 'files');
  outside = path.join(base, 'files-sibling');
  await mkdir(root);
  await mkdir(outside);
  storage = await LocalVolumeFileStorage.open(root);
});
afterEach(() => rm(base, { recursive: true, force: true }));

describe('originalObjectKey', () => {
  it('is built from scope and file UUID only', () => {
    const id = randomUUID();
    const ws = randomUUID();
    expect(originalObjectKey(globalScope(), id)).toBe(`originals/global/${id}`);
    expect(originalObjectKey(workspaceScope(ws), id.toUpperCase())).toBe(`originals/workspaces/${ws}/${id}`);
  });

  it('rejects anything that is not a UUID, such as an uploaded name', () => {
    for (const bad of ['../x', 'report.pdf', '', 'a/b', `${randomUUID()}/../x`]) {
      expect(() => originalObjectKey(globalScope(), bad)).toThrow(InvalidStorageKeyError);
    }
  });
});

describe('LocalVolumeFileStorage', () => {
  const key = () => originalObjectKey(globalScope(), randomUUID());

  it('stores bytes and streams the same bytes back', async () => {
    const k = key();
    const bytes = Buffer.from(Array.from({ length: 5000 }, (_, i) => i % 256));
    expect(await storage.put(k, Readable.from([bytes.subarray(0, 100), bytes.subarray(100)]))).toEqual({ size: 5000 });
    expect(await storage.exists(k)).toBe(true);
    expect((await read(await storage.get(k))).equals(bytes)).toBe(true);
  });

  it('stores workspace objects under their own directory', async () => {
    const k = originalObjectKey(workspaceScope(randomUUID()), randomUUID());
    await storage.put(k, Readable.from([Buffer.from('ws')]));
    expect((await read(await storage.get(k))).toString()).toBe('ws');
  });

  it('keeps the object invisible until the stream completed, then renames it into place', async () => {
    const k = key();
    const source = new PassThrough();
    const done = storage.put(k, source);
    source.write('part one');
    await new Promise((r) => setTimeout(r, 50));
    expect(await storage.exists(k)).toBe(false);
    const tmpFiles = await readdir(path.join(root, '.tmp'));
    expect(tmpFiles).toHaveLength(1);
    source.end(' part two');
    await done;
    expect(await storage.exists(k)).toBe(true);
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
    expect((await read(await storage.get(k))).toString()).toBe('part one part two');
  });

  it('removes the temporary file and leaves no object when the stream fails', async () => {
    const k = key();
    const source = new PassThrough();
    const done = storage.put(k, source);
    source.write('partial');
    await new Promise((r) => setTimeout(r, 50));
    source.destroy(new Error('client went away'));
    await expect(done).rejects.toThrow();
    expect(await storage.exists(k)).toBe(false);
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
  });

  it('removes the temporary file when the stream is aborted without an error', async () => {
    const k = key();
    const source = new PassThrough();
    const done = storage.put(k, source);
    source.write('partial');
    await new Promise((r) => setTimeout(r, 50));
    source.destroy();
    await expect(done).rejects.toThrow();
    expect(await storage.exists(k)).toBe(false);
    expect(await readdir(path.join(root, '.tmp'))).toEqual([]);
  });

  it('keeps an existing object when a replacing write fails', async () => {
    const k = key();
    await storage.put(k, Readable.from([Buffer.from('original')]));
    const failing = new Readable({ read() { this.destroy(new Error('boom')); } });
    await expect(storage.put(k, failing)).rejects.toThrow();
    expect((await read(await storage.get(k))).toString()).toBe('original');
  });

  it('reports a missing object', async () => {
    const k = key();
    expect(await storage.exists(k)).toBe(false);
    await expect(storage.get(k)).rejects.toBeInstanceOf(StorageObjectNotFoundError);
  });

  it('deletes and tolerates repeated deletion', async () => {
    const k = key();
    await storage.put(k, Readable.from([Buffer.from('x')]));
    await storage.delete(k);
    expect(await storage.exists(k)).toBe(false);
    await expect(storage.delete(k)).resolves.toBeUndefined();
    await expect(storage.delete(key())).resolves.toBeUndefined();
  });

  describe('rejects keys outside the root', () => {
    const id = randomUUID();
    const bad = [
      '../files-sibling/x',
      `originals/global/../../../files-sibling/${id}`,
      `/etc/${id}`,
      path.join(base ?? '/tmp', 'x'),
      `originals/global/${id}.pdf`,
      `originals\\global\\${id}`,
      `originals/global/${id}/`,
      `./originals/global/${id}`,
      `originals//global/${id}`,
      `originals/global/${id}\0`,
      '',
      '.tmp/abc.part',
    ];
    it.each(bad)('key %j', async (k) => {
      const data = Readable.from([Buffer.from('x')]);
      await expect(storage.put(k, data)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.get(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    });

    it('error messages do not reveal keys or paths', async () => {
      const err = await storage.exists(`../${root}`).catch((e: Error) => e);
      expect((err as Error).message).toBe('Invalid storage key');
    });
  });

  describe('rejects symlink escapes', () => {
    it('a symlinked scope directory', async () => {
      const ws = randomUUID();
      await mkdir(path.join(root, 'originals', 'workspaces'), { recursive: true });
      await symlink(outside, path.join(root, 'originals', 'workspaces', ws));
      const k = originalObjectKey(workspaceScope(ws), randomUUID());
      await expect(storage.put(k, Readable.from([Buffer.from('leak')]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
      expect(await readdir(outside)).toEqual([]);
    });

    it('a symlinked originals directory, for every operation', async () => {
      await symlink(outside, path.join(root, 'originals'));
      const id = randomUUID();
      await writeFile(path.join(outside, 'global'), 'not a dir');
      const k = originalObjectKey(globalScope(), id);
      await expect(storage.put(k, Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.get(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
    });

    it('a symlink in place of the object, which is never read or deleted through', async () => {
      const id = randomUUID();
      const secret = path.join(outside, 'secret.txt');
      await writeFile(secret, 'secret');
      await mkdir(path.join(root, 'originals', 'global'), { recursive: true });
      await symlink(secret, path.join(root, 'originals', 'global', id));
      const k = originalObjectKey(globalScope(), id);
      await expect(storage.get(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.exists(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.delete(k)).rejects.toBeInstanceOf(InvalidStorageKeyError);
      await expect(storage.put(k, Readable.from([Buffer.from('x')]))).rejects.toBeInstanceOf(InvalidStorageKeyError);
      expect(await readFile(secret, 'utf8')).toBe('secret');
    });
  });
});

describe('LocalVolumeFileStorage.open', () => {
  const reason = async (dir: string | undefined) => {
    const err = await LocalVolumeFileStorage.open(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  };

  it('fails when the directory is not configured', async () => {
    expect(await reason(undefined)).toBe('Invalid configuration: FILE_STORAGE_DIR (is required)');
  });

  it('fails without echoing the path when the directory is missing or a file', async () => {
    const missing = path.join(base, 'secret-missing-dir');
    const message = await reason(missing);
    expect(message).toBe('Invalid configuration: FILE_STORAGE_DIR (must be an existing directory)');
    expect(message).not.toContain('secret-missing-dir');
    const file = path.join(base, 'a-file');
    await writeFile(file, 'x');
    expect(await reason(file)).toBe('Invalid configuration: FILE_STORAGE_DIR (must be an existing directory)');
  });

  it.skipIf(process.getuid?.() === 0)('fails when the directory is not writable', async () => {
    const { chmod } = await import('node:fs/promises');
    const ro = path.join(base, 'ro');
    await mkdir(ro);
    await chmod(ro, 0o500);
    try {
      expect(await reason(ro)).toBe('Invalid configuration: FILE_STORAGE_DIR (must be a writable directory)');
    } finally {
      await chmod(ro, 0o700);
    }
  });

  it('uses the canonical path when the configured directory is a symlink', async () => {
    const link = path.join(base, 'link');
    await symlink(root, link);
    const viaLink = await LocalVolumeFileStorage.open(link);
    const k = originalObjectKey(globalScope(), randomUUID());
    await viaLink.put(k, Readable.from([Buffer.from('ok')]));
    expect(await storage.exists(k)).toBe(true);
  });
});
