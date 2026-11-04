import { describe, expect, it, vi } from 'vitest';
import { ApiKeyStore, ApiKeyStoreError, MAX_PREFIX_ATTEMPTS } from './api-key.store.js';

const PEPPER = 'unit-test-pepper-0123456789abcdefghij';
const SENTINEL_DIGEST = 'SENTINEL-DIGEST-PARAM';

function storeWith(transaction: () => Promise<unknown>): ApiKeyStore {
  const repo = { manager: { transaction } } as never;
  return new ApiKeyStore(repo, { apiKeyPepper: PEPPER });
}

/** A driver error shaped like TypeORM's QueryFailedError, carrying the query parameters. */
function queryFailed(code: string, constraint?: string): Error {
  return Object.assign(new Error(`insert failed with ${SENTINEL_DIGEST} and ${PEPPER}`), {
    driverError: { code, constraint },
    parameters: [SENTINEL_DIGEST, PEPPER],
    query: 'INSERT INTO api_keys',
  });
}

const INPUT = { workspaceId: 'w', name: 'k', permissions: ['search'] as const };

describe('ApiKeyStore.create error handling', () => {
  it('retries a prefix collision a bounded number of times, then fails sanitized', async () => {
    const transaction = vi.fn().mockRejectedValue(queryFailed('23505', 'UQ_api_keys_prefix'));
    const err = await storeWith(transaction).create(INPUT).catch((e) => e);
    expect(transaction).toHaveBeenCalledTimes(MAX_PREFIX_ATTEMPTS);
    expect(err).toBeInstanceOf(ApiKeyStoreError);
    expect(err.code).toBe('prefix_collision');
  });

  it('never leaks driver messages, parameters, digests or the pepper', async () => {
    for (const code of ['08006', '23503', '23505', 'XX000']) {
      const err = await storeWith(vi.fn().mockRejectedValue(queryFailed(code, 'other'))).create(INPUT).catch((e) => e);
      expect(err).toBeInstanceOf(ApiKeyStoreError);
      const text = `${err.message} ${JSON.stringify(err)} ${err.stack}`;
      expect(text).not.toContain(SENTINEL_DIGEST);
      expect(text).not.toContain(PEPPER);
      expect(err.cause).toBeUndefined();
    }
  });

  it('refuses empty or unknown permissions before touching the database', async () => {
    const transaction = vi.fn();
    const store = storeWith(transaction);
    for (const permissions of [[], ['files:admin'], ['search', 'nope']]) {
      await expect(store.create({ ...INPUT, permissions: permissions as never })).rejects.toMatchObject({
        code: 'invalid_permissions',
      });
    }
    expect(transaction).not.toHaveBeenCalled();
  });
});
