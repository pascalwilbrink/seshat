import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, getActionRequirement, type Permission } from '@seshat/domain';
import { ACTIONS, AuthorizationService, type Action } from './authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from './principal.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';

const service = new AuthorizationService();
const WS = workspaceScope('0b3d6f0e-6c2a-4a58-9f0e-3f1a2b3c4d5e');

describe('AuthorizationService', () => {
  it.each(ACTIONS)('allows the admin to %s in Global and Workspace scope', (action) => {
    expect(() => service.assertCan(ADMIN_PRINCIPAL, action, globalScope())).not.toThrow();
    expect(() => service.assertCan(ADMIN_PRINCIPAL, action, WS)).not.toThrow();
  });

  const unknownKinds: unknown[] = [{ kind: 'api_key' }, { kind: 'ADMIN' }, { kind: '' }, {}, null, undefined, 'admin', 7];

  it.each(unknownKinds.map((p, i) => [i, p] as const))('denies unrecognized principal #%i', (_i, principal) => {
    expect(() => service.assertCan(principal as Principal, 'workspace:list', globalScope())).toThrow(ForbiddenException);
  });

  it('denies unknown actions and unrecognized scopes', () => {
    expect(service.can(ADMIN_PRINCIPAL, 'workspace:explode' as Action, globalScope())).toBe(false);
    expect(service.can(ADMIN_PRINCIPAL, 'workspace:list', { kind: 'other' } as never)).toBe(false);
    expect(service.can(ADMIN_PRINCIPAL, 'workspace:list', undefined as never)).toBe(false);
  });

  it('denies Workspace scope with the same NotFound a missing Workspace produces', () => {
    const attempts: Array<() => void> = [
      () => service.assertCan({ kind: 'api_key' } as never, 'workspace:read', WS),
      () => service.assertCan(null as never, 'workspace:read', WS),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try {
        attempt();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(NotFoundException);
      expect((caught as NotFoundException).getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
    }
  });
});

describe('AuthorizationService: API keys', () => {
  const OWN = '0b3d6f0e-6c2a-4a58-9f0e-3f1a2b3c4d5e';
  const OTHER = '7c1d2e3f-0000-4000-8000-000000000001';
  const key = (permissions: readonly Permission[], workspaceId = OWN): Principal => ({ kind: 'apiKey', keyId: 'k1', workspaceId, permissions });
  const own = workspaceScope(OWN);
  const other = workspaceScope(OTHER);
  const catch_ = (fn: () => void): unknown => {
    try {
      fn();
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it('allows an own-Workspace action with the mapped permission', () => {
    expect(() => service.assertCan(key(['files:write']), 'file.upload', own)).not.toThrow();
    expect(() => service.assertCan(key(['search']), 'search.query', own)).not.toThrow();
  });

  it('names only the missing permission with a 403', () => {
    const err = catch_(() => service.assertCan(key(['files:read']), 'file.upload', own)) as ForbiddenException;
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe('Missing permission: files:write');
  });

  it('does not let another permission stand in', () => {
    for (const p of PERMISSIONS.filter((x) => x !== 'memories:delete')) {
      expect(service.can(key([p]), 'memory.forget', own)).toBe(false);
    }
  });

  it('answers another Workspace and a missing one identically, for every action and permission set', () => {
    const missing = workspaceScope('7c1d2e3f-0000-4000-8000-0000000000ff');
    for (const action of ACTIONS) {
      for (const perms of [[], [...PERMISSIONS]] as Permission[][]) {
        const a = catch_(() => service.assertCan(key(perms), action, other)) as NotFoundException;
        const b = catch_(() => service.assertCan(key(perms), action, missing)) as NotFoundException;
        expect(a).toBeInstanceOf(NotFoundException);
        expect(a.getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
        expect(b.getResponse()).toEqual(a.getResponse());
      }
    }
  });

  it('requires the read permission and global:read for Global reads', () => {
    expect(() => service.assertCan(key(['files:read', 'global:read']), 'file.list', globalScope())).not.toThrow();
    expect(() => service.assertCan(key(['search', 'global:read']), 'search.query', globalScope())).not.toThrow();
    expect((catch_(() => service.assertCan(key(['global:read']), 'file.list', globalScope())) as Error).message).toBe('Missing permission: files:read');
    expect((catch_(() => service.assertCan(key(['files:read']), 'file.list', globalScope())) as Error).message).toBe('Missing permission: global:read');
    expect(service.can(key(['files:write', 'global:read']), 'file.list', globalScope())).toBe(false);
  });

  it('never lets a key write, delete or manage in Global, even with every permission', () => {
    const all = key([...PERMISSIONS]);
    for (const action of ACTIONS) {
      const c = getActionRequirement(action)!.classification;
      if (c === 'write' || c === 'delete' || c === 'admin') {
        const err = catch_(() => service.assertCan(all, action, globalScope()));
        expect(err, action).toBeInstanceOf(ForbiddenException);
        expect((err as Error).message).toBe('Forbidden');
      }
    }
  });

  it('denies admin-only actions in the own Workspace with 403', () => {
    const all = key([...PERMISSIONS]);
    for (const action of ['workspace:read', 'workspace:update', 'workspace:delete', 'apiKey:create', 'apiKey:list', 'apiKey:update', 'apiKey:revoke', 'overview:read'] as const) {
      expect(catch_(() => service.assertCan(all, action, own)), action).toBeInstanceOf(ForbiddenException);
    }
    expect(service.can(all, 'workspace:list', globalScope())).toBe(false);
    expect(service.can(all, 'workspace:create', globalScope())).toBe(false);
  });

  it('lets a key read its own identity but not end the admin session', () => {
    expect(service.can(key([]), 'session:read', globalScope())).toBe(true);
    expect(service.can(key([]), 'session:end', globalScope())).toBe(false);
  });

  it('fails closed on unknown actions and malformed key principals', () => {
    expect(service.can(key(['files:read']), 'file.explode' as Action, own)).toBe(false);
    expect(service.can(key([...PERMISSIONS]), '__proto__' as Action, globalScope())).toBe(false);
    const bad: unknown[] = [
      { kind: 'apiKey' },
      { kind: 'apiKey', keyId: 'k', workspaceId: 'nope', permissions: ['files:read'] },
      { kind: 'apiKey', keyId: 'k', workspaceId: OWN, permissions: ['files:read', 'files:admin'] },
      { kind: 'apiKey', keyId: 'k', workspaceId: OWN, permissions: 'files:read' },
      { kind: 'apiKey', keyId: 1, workspaceId: OWN, permissions: [] },
    ];
    for (const p of bad) {
      expect(catch_(() => service.assertCan(p as Principal, 'file.list', own))).toBeInstanceOf(NotFoundException);
      expect(catch_(() => service.assertCan(p as Principal, 'file.list', globalScope()))).toBeInstanceOf(ForbiddenException);
    }
  });

  it('keeps the admin allowed for the new actions in every scope', () => {
    for (const action of ACTIONS) {
      expect(service.can(ADMIN_PRINCIPAL, action, own)).toBe(true);
      expect(service.can(ADMIN_PRINCIPAL, action, globalScope())).toBe(true);
    }
  });
});
