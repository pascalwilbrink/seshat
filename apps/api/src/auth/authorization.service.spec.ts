import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
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
