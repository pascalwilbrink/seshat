import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { parsePermissions, type Permission } from '@seshat/domain';
import type { Repository } from 'typeorm';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { ApiKey } from './api-key.entity.js';
import { computeApiKeyHmac, generateApiKey, parseApiKeyPrefix, verifyApiKey } from './api-key-crypto.js';

export const MAX_PREFIX_ATTEMPTS = 5;
/** `last_used_at` is written at most once per this many seconds per key. */
export const LAST_USED_THROTTLE_SECONDS = 60;

/** Sanitized storage failure. The message is fixed text: it never carries SQL parameters, digests or keys. */
export class ApiKeyStoreError extends Error {
  constructor(readonly code: 'prefix_collision' | 'workspace_not_found' | 'invalid_permissions' | 'persistence_failed') {
    super(`API key storage failed (${code})`);
    this.name = 'ApiKeyStoreError';
  }
}

/** Safe key metadata: no digest, no secret. */
export interface ApiKeyRecord {
  id: string;
  workspaceId: string;
  name: string;
  prefix: string;
  permissions: Permission[];
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/**
 * Narrow, internal result of key creation, for the create service only. The full key is a non-enumerable
 * property and serialization, inspection and string conversion are redacted, so it cannot leak by accident.
 */
export class GeneratedApiKey {
  constructor(
    readonly record: ApiKeyRecord,
    secret: string,
  ) {
    Object.defineProperty(this, 'secret', { value: secret, enumerable: false });
  }
  declare readonly secret: string;
  toJSON(): { record: ApiKeyRecord; secret: string } {
    return { record: this.record, secret: '[redacted]' };
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return 'GeneratedApiKey { secret: [redacted] }';
  }
  toString(): string {
    return '[redacted]';
  }
}

function toRecord(row: ApiKey): ApiKeyRecord {
  const permissions = parsePermissions(row.permissions);
  // Fail closed: a row with unknown or no permissions grants nothing.
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    prefix: row.prefix,
    permissions: permissions && permissions.length > 0 ? permissions : [],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
  };
}

function pgError(err: unknown): { code?: string; constraint?: string } {
  const driver = (err as { driverError?: { code?: unknown; constraint?: unknown } } | null)?.driverError ?? {};
  return {
    code: typeof driver.code === 'string' ? driver.code : undefined,
    constraint: typeof driver.constraint === 'string' ? driver.constraint : undefined,
  };
}

@Injectable()
export class ApiKeyStore {
  /** Replaceable in tests (collision retries). */
  generator: typeof generateApiKey = generateApiKey;

  constructor(
    @InjectRepository(ApiKey) private readonly keys: Repository<ApiKey>,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'apiKeyPepper'>,
  ) {}

  /**
   * Creates a key for a Workspace. Retries with a fresh prefix on a prefix collision, at most
   * MAX_PREFIX_ATTEMPTS times. Raw driver errors (which carry the query parameters, i.e. the digest) are
   * never propagated.
   */
  async create(input: {
    workspaceId: string;
    name: string;
    permissions: readonly Permission[];
    expiresAt?: Date | null;
  }): Promise<GeneratedApiKey> {
    const permissions = parsePermissions([...input.permissions]);
    if (!permissions || permissions.length === 0) throw new ApiKeyStoreError('invalid_permissions');

    for (let attempt = 0; attempt < MAX_PREFIX_ATTEMPTS; attempt++) {
      const { key, prefix } = this.generator();
      try {
        const saved = await this.keys.manager.transaction(async (m) => {
          const result = await m
            .createQueryBuilder()
            .insert()
            .into(ApiKey)
            .values({
              workspaceId: input.workspaceId,
              name: input.name,
              prefix,
              keyHmac: computeApiKeyHmac(this.config.apiKeyPepper, key),
              permissions,
              expiresAt: input.expiresAt ?? null,
            })
            .returning(['id'])
            .execute();
          return m.findOneByOrFail(ApiKey, { id: (result.raw as Array<{ id: string }>)[0]!.id });
        });
        return new GeneratedApiKey(toRecord(saved), key);
      } catch (err) {
        const { code, constraint } = pgError(err);
        if (code === '23505' && constraint === 'UQ_api_keys_prefix') continue;
        if (code === '23503') throw new ApiKeyStoreError('workspace_not_found');
        throw new ApiKeyStoreError('persistence_failed');
      }
    }
    throw new ApiKeyStoreError('prefix_collision');
  }

  /**
   * Resolves a presented key to its record when, and only when, the HMAC matches (constant-time). Returns
   * the current revocation, expiry and permissions state, fetched on every call: nothing is cached. Callers
   * must still reject revoked and expired keys.
   */
  async findByKey(presented: unknown): Promise<ApiKeyRecord | null> {
    const prefix = parseApiKeyPrefix(presented);
    let row: ApiKey | null = null;
    if (prefix) {
      try {
        row = await this.keys
          .createQueryBuilder('k')
          .addSelect('k.keyHmac')
          .where('k.prefix = :prefix', { prefix })
          .getOne();
      } catch {
        throw new ApiKeyStoreError('persistence_failed');
      }
    }
    // Always compare, against a dummy digest when the prefix is malformed or unknown.
    const ok = verifyApiKey(this.config.apiKeyPepper, presented, row?.keyHmac ?? null);
    return ok && row ? toRecord(row) : null;
  }

  /** All keys of a Workspace, newest first. */
  async list(workspaceId: string): Promise<ApiKeyRecord[]> {
    try {
      const rows = await this.keys.find({ where: { workspaceId }, order: { createdAt: 'DESC', id: 'ASC' } });
      return rows.map(toRecord);
    } catch {
      throw new ApiKeyStoreError('persistence_failed');
    }
  }

  /** Edits name and/or permissions of a non-revoked key, looked up by Workspace AND key id. Never touches anything else. */
  async update(
    workspaceId: string,
    id: string,
    changes: { name?: string; permissions?: readonly Permission[] },
  ): Promise<ApiKeyRecord | 'not_found' | 'revoked'> {
    const permissions = changes.permissions === undefined ? undefined : parsePermissions([...changes.permissions]);
    if (permissions === null || (permissions && permissions.length === 0)) throw new ApiKeyStoreError('invalid_permissions');
    const set: Partial<Pick<ApiKey, 'name' | 'permissions'>> = {};
    if (changes.name !== undefined) set.name = changes.name;
    if (permissions) set.permissions = permissions;
    try {
      if (Object.keys(set).length > 0) {
        await this.keys
          .createQueryBuilder()
          .update(ApiKey)
          .set(set)
          .where('id = :id AND workspace_id = :workspaceId AND revoked_at IS NULL', { id, workspaceId })
          .execute();
      }
      const row = await this.keys.findOne({ where: { id, workspaceId } });
      if (!row) return 'not_found';
      return row.revokedAt ? 'revoked' : toRecord(row);
    } catch {
      throw new ApiKeyStoreError('persistence_failed');
    }
  }

  /** Soft revoke by Workspace AND key id. Idempotent: an already revoked key keeps its original revocation time. */
  async revoke(workspaceId: string, id: string): Promise<ApiKeyRecord | null> {
    try {
      await this.keys
        .createQueryBuilder()
        .update(ApiKey)
        .set({ revokedAt: () => 'now()' })
        .where('id = :id AND workspace_id = :workspaceId AND revoked_at IS NULL', { id, workspaceId })
        .execute();
      const row = await this.keys.findOne({ where: { id, workspaceId } });
      return row ? toRecord(row) : null;
    } catch {
      throw new ApiKeyStoreError('persistence_failed');
    }
  }

  /**
   * Sets last_used_at to the database clock if it is unset or older than the throttle window. A single
   * conditional UPDATE: concurrent calls (also from other processes) serialize on the row lock and the
   * losers re-check the condition, so at most one write happens per window. Returns whether it wrote.
   */
  async touchLastUsed(id: string): Promise<boolean> {
    try {
      const result = await this.keys
        .createQueryBuilder()
        .update(ApiKey)
        .set({ lastUsedAt: () => 'now()' })
        .where('id = :id', { id })
        .andWhere(`(last_used_at IS NULL OR last_used_at <= now() - make_interval(secs => :secs))`, {
          secs: LAST_USED_THROTTLE_SECONDS,
        })
        .execute();
      return (result.affected ?? 0) > 0;
    } catch {
      throw new ApiKeyStoreError('persistence_failed');
    }
  }
}
