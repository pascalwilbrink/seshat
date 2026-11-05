import 'reflect-metadata';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { Permission } from '@seshat/domain';
import { describe, expect, it, vi } from 'vitest';
import { AuthorizationService } from '../auth/authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from '../auth/principal.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';
import { TagsService, scopeKeyOf } from './tags.service.js';

const WS = '3f1d2c4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
const OTHER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
const TAG = '11111111-2222-4333-8444-555555555555';

const key = (workspaceId: string, ...permissions: Permission[]): Principal => ({ kind: 'apiKey', keyId: 'k', keyName: 'key', workspaceId, permissions });

function setup() {
  const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => []);
  const service = new TagsService({ query, transaction: vi.fn() } as never, new AuthorizationService());
  return { query, service };
}

describe('TagsService authorization (before any database access)', () => {
  const ops = {
    list: (s: TagsService, p: Principal, scope = workspaceScope(WS)) => s.list(p, scope),
    rename: (s: TagsService, p: Principal, scope = workspaceScope(WS)) => s.rename(p, scope, TAG, { name: 'x' }),
    remove: (s: TagsService, p: Principal, scope = workspaceScope(WS)) => s.remove(p, scope, TAG),
  };
  const pairs = {
    list: ['files:read', 'memories:read'],
    rename: ['files:write', 'memories:write'],
    remove: ['files:write', 'memories:write'],
  } as const;

  for (const op of ['list', 'rename', 'remove'] as const) {
    it(`${op}: each qualifying permission works alone, neither is a 403 naming permissions only`, async () => {
      for (const p of pairs[op]) {
        const { service, query } = setup();
        const row = { id: TAG, name: 'x', scope: 'workspace', workspace_id: WS, file_count: 0, created_at: new Date(), updated_at: new Date() };
        query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') || sql.startsWith('\n  SELECT') || sql.includes('FROM tags t') ? [row] : [[{ id: TAG }], 1]));
        await expect(ops[op](service, key(WS, p))).resolves.not.toThrow();
      }
      const { service, query } = setup();
      const err = await ops[op](service, key(WS, 'collections:read', 'collections:write', 'files:delete', 'search')).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(query).not.toHaveBeenCalled();
    });

    it(`${op}: a foreign Workspace is the generic 404 and never queries`, async () => {
      const { service, query } = setup();
      const err = await ops[op](service, key(OTHER, ...pairs[op], 'global:read')).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(err.message).toBe('Not Found');
      expect(query).not.toHaveBeenCalled();
    });

    it(`${op}: Global without the grant is the generic 404`, async () => {
      const { service, query } = setup();
      const err = await ops[op](service, key(WS, ...pairs[op]), globalScope()).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      expect(query).not.toHaveBeenCalled();
    });
  }

  it('Global read with either permission plus global:read succeeds; mutations never do', async () => {
    for (const p of ['files:read', 'memories:read'] as const) {
      const { service } = setup();
      await expect(service.list(key(WS, p, 'global:read'), globalScope())).resolves.toEqual([]);
    }
    const { service, query } = setup();
    const all = key(WS, 'files:read', 'memories:read', 'files:write', 'memories:write', 'global:read');
    await expect(service.rename(all, globalScope(), TAG, { name: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.remove(all, globalScope(), TAG)).rejects.toBeInstanceOf(ForbiddenException);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('TagsService management', () => {
  it('filters every statement on the scope key', async () => {
    const { service, query } = setup();
    await service.list(ADMIN_PRINCIPAL, workspaceScope(WS.toUpperCase()));
    expect(query.mock.calls[0]![1]).toEqual([WS]);
    await service.list(ADMIN_PRINCIPAL, globalScope());
    expect(query.mock.calls[1]![1]).toEqual(['global']);
    expect(scopeKeyOf(globalScope())).toBe('global');
  });

  it('answers a malformed id and a missing row with the same 404', async () => {
    const { service, query } = setup();
    query.mockResolvedValue([[], 0]);
    const a = await service.remove(ADMIN_PRINCIPAL, globalScope(), 'not-a-uuid').catch((e) => e);
    const b = await service.remove(ADMIN_PRINCIPAL, globalScope(), TAG).catch((e) => e);
    expect(a).toBeInstanceOf(NotFoundException);
    expect(b).toBeInstanceOf(NotFoundException);
    expect(a.getResponse()).toEqual(b.getResponse());
  });

  it('turns a unique violation on rename into a sanitized conflict', async () => {
    const { service, query } = setup();
    query.mockRejectedValue(Object.assign(new Error('duplicate key value violates "UQ_tags_scope_key_name" (secret)'), { driverError: { code: '23505' } }));
    const err = await service.rename(ADMIN_PRINCIPAL, globalScope(), TAG, { name: 'taken' }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(JSON.stringify(err.getResponse())).not.toContain('secret');
  });
});
