import type { Readable } from 'node:stream';
import { isUuid, type ScopeRef } from '../scopes/scope-ref.js';

/** Injection token for the FileStorage implementation (explicit, since Vitest emits no decorator metadata). */
export const FILE_STORAGE = Symbol('FILE_STORAGE');

/**
 * Storage of original uploaded bytes. Consumers depend on this interface only; keys come from
 * `originalObjectKey`, never from an uploaded file name.
 */
export interface FileStorage {
  /** Stores the stream under `key`. The object becomes visible only after the stream completed successfully. */
  put(key: string, stream: Readable): Promise<{ size: number }>;
  /** Streams the stored bytes. Rejects with `StorageObjectNotFoundError` when the object does not exist. */
  get(key: string): Promise<Readable>;
  /** Removes the object. Succeeds when it is already missing. */
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export type StorageErrorCode = 'invalid_key' | 'not_found';

/** Errors never carry keys or filesystem paths. */
export class StorageError extends Error {
  constructor(readonly code: StorageErrorCode, message: string) {
    super(message);
    this.name = 'StorageError';
  }
}

export class InvalidStorageKeyError extends StorageError {
  constructor() {
    super('invalid_key', 'Invalid storage key');
    this.name = 'InvalidStorageKeyError';
  }
}

export class StorageObjectNotFoundError extends StorageError {
  constructor() {
    super('not_found', 'Stored object not found');
    this.name = 'StorageObjectNotFoundError';
  }
}

/** Originals live under their own prefix, so extracted text or chunks can get a sibling prefix later. */
export const ORIGINALS_PREFIX = 'originals';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ORIGINAL_KEY_RE = new RegExp(`^${ORIGINALS_PREFIX}/(?:global|workspaces/${UUID})/${UUID}$`);

/** True for a key shaped like the ones `originalObjectKey` generates (lowercase, no other characters). */
export function isOriginalObjectKey(key: unknown): key is string {
  return typeof key === 'string' && ORIGINAL_KEY_RE.test(key);
}

/** `originals/global/<fileId>` or `originals/workspaces/<workspaceId>/<fileId>`, from explicit scope and file UUID. */
export function originalObjectKey(scope: ScopeRef, fileId: string): string {
  if (!isUuid(fileId)) throw new InvalidStorageKeyError();
  const id = fileId.toLowerCase();
  const key =
    scope.kind === 'global'
      ? `${ORIGINALS_PREFIX}/global/${id}`
      : `${ORIGINALS_PREFIX}/workspaces/${scope.workspaceId.toLowerCase()}/${id}`;
  if (!isOriginalObjectKey(key)) throw new InvalidStorageKeyError();
  return key;
}
