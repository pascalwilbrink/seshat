import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { PERMISSIONS, type Permission } from '@seshat/domain';
import { AuthorizationService } from '../auth/authorization.service.js';
import { ADMIN_PRINCIPAL, type Principal } from '../auth/principal.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';
import { expectedSearchOutcome } from '../../test/helpers/policy-oracle.js';
import type { SearchType } from './search-plan.js';

const OWN = '0b3d6f0e-6c2a-4a58-9f0e-3f1a2b3c4d5e';
const OTHER = '7c1d2e3f-0000-4000-8000-000000000001';
const service = new AuthorizationService();
const keyWith = (permissions: readonly Permission[]): Principal => ({ kind: 'apiKey', keyId: 'k', keyName: 'key', workspaceId: OWN, permissions });
const scopes = { own: workspaceScope(OWN), other: workspaceScope(OTHER), global: globalScope() };
const attempt = (p: Principal, where: keyof typeof scopes, types: SearchType[], includeGlobal: boolean) => {
  try {
    return { status: 'allow' as const, plan: service.authorizeSearch(p, scopes[where], { types, includeGlobal }) };
  } catch (e) {
    if (e instanceof NotFoundException) {
      expect(e.getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
      return { status: 404 as const };
    }
    if (e instanceof ForbiddenException) return { status: 403 as const, message: e.message };
    throw e;
  }
};

const typeSets: SearchType[][] = [['files', 'memories'], ['files'], ['memories']];
/** Subsets of the ten permissions chosen to hit every requirement alone and missing. */
function heldSets(): Permission[][] {
  const sets: Permission[][] = [[], [...PERMISSIONS]];
  for (const p of PERMISSIONS) {
    sets.push([p], PERMISSIONS.filter((q) => q !== p));
  }
  sets.push(['search', 'files:read'], ['search', 'memories:read'], ['search', 'files:read', 'memories:read'], ['search', 'files:read', 'global:read'], ['search', 'memories:read', 'global:read'], ['search', 'files:read', 'memories:read', 'global:read']);
  return sets;
}

describe('authorizeSearch: matrix against the independent oracle', () => {
  for (const where of ['own', 'other', 'global'] as const) {
    for (const types of typeSets) {
      for (const includeGlobal of [false, true]) {
        it(`${where} types=${types.join('+')} includeGlobal=${includeGlobal}`, () => {
          for (const held of heldSets()) {
            const want = expectedSearchOutcome(held, where, types, includeGlobal);
            const got = attempt(keyWith(held), where, types, includeGlobal);
            expect({ status: got.status, message: 'message' in got ? got.message : undefined }, held.join(',')).toEqual({
              status: want.status,
              message: 'message' in want ? want.message : undefined,
            });
          }
        });
      }
    }
  }
});

describe('authorizeSearch: plans', () => {
  const all = keyWith(PERMISSIONS);

  it('admin: route scope only, both types by default', () => {
    expect(service.authorizeSearch(ADMIN_PRINCIPAL, scopes.own, { types: ['files', 'memories'], includeGlobal: false })).toEqual({
      scopes: [scopes.own], types: ['files', 'memories'],
    });
    expect(service.authorizeSearch(ADMIN_PRINCIPAL, scopes.global, { types: ['memories'], includeGlobal: false })).toEqual({ scopes: [scopes.global], types: ['memories'] });
  });

  it('admin on a foreign-looking Workspace still plans (existence is the controller pipe\'s job)', () => {
    expect(service.authorizeSearch(ADMIN_PRINCIPAL, scopes.other, { types: ['files'], includeGlobal: false }).scopes).toEqual([scopes.other]);
  });

  it('a Global grant never enables Global unless includeGlobal is requested', () => {
    expect(service.authorizeSearch(all, scopes.own, { types: ['files', 'memories'], includeGlobal: false }).scopes).toEqual([scopes.own]);
    expect(service.authorizeSearch(ADMIN_PRINCIPAL, scopes.own, { types: ['files'], includeGlobal: false }).scopes).toEqual([scopes.own]);
  });

  it('includeGlobal adds Global after the Workspace, only with the grant', () => {
    expect(service.authorizeSearch(all, scopes.own, { types: ['files'], includeGlobal: true }).scopes).toEqual([scopes.own, scopes.global]);
    expect(service.authorizeSearch(ADMIN_PRINCIPAL, scopes.own, { types: ['files'], includeGlobal: true }).scopes).toEqual([scopes.own, scopes.global]);
  });

  it('includeGlobal on the Global route never duplicates or widens', () => {
    expect(service.authorizeSearch(all, scopes.global, { types: ['files'], includeGlobal: true }).scopes).toEqual([scopes.global]);
  });

  it('single-type plans contain only the requested readable type', () => {
    const filesOnly = keyWith(['search', 'files:read']);
    expect(service.authorizeSearch(filesOnly, scopes.own, { types: ['files'], includeGlobal: false }).types).toEqual(['files']);
    expect(attempt(filesOnly, 'own', ['files', 'memories'], false)).toEqual({ status: 403, message: 'Missing permission: memories:read' });
    expect(attempt(filesOnly, 'own', ['memories'], false)).toEqual({ status: 403, message: 'Missing permission: memories:read' });
  });

  it('types come out in canonical order, deduplicated', () => {
    expect(service.authorizeSearch(all, scopes.own, { types: ['memories', 'files', 'memories'], includeGlobal: false }).types).toEqual(['files', 'memories']);
  });

  it('plans are frozen', () => {
    const plan = service.authorizeSearch(all, scopes.own, { types: ['files'], includeGlobal: true });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.scopes)).toBe(true);
    expect(Object.isFrozen(plan.types)).toBe(true);
  });
});

describe('authorizeSearch: denials', () => {
  it('names every missing requested permission in canonical order', () => {
    expect(attempt(keyWith([]), 'own', ['files', 'memories'], true)).toEqual({ status: 403, message: 'Missing permission: search, files:read, memories:read, global:read' });
    expect(attempt(keyWith(['files:read']), 'own', ['files'], false)).toEqual({ status: 403, message: 'Missing permission: search' });
    expect(attempt(keyWith(['search', 'files:read']), 'own', ['files'], true)).toEqual({ status: 403, message: 'Missing permission: global:read' });
    expect(attempt(keyWith(['search', 'files:read', 'memories:read']), 'global', ['files', 'memories'], false)).toEqual({ status: 403, message: 'Missing permission: global:read' });
  });

  it('the Global route names missing grants instead of concealing Global with a 404 (unlike the Files family)', () => {
    expect(attempt(keyWith(['search', 'memories:read']), 'global', ['files'], false)).toEqual({ status: 403, message: 'Missing permission: files:read, global:read' });
    expect(() => service.assertCan(keyWith(['search', 'memories:read']), 'file.list', scopes.global)).toThrow(NotFoundException);
  });

  it('does not accept the catalog any-of grants: files:read alone is not enough for memories', () => {
    expect(attempt(keyWith(['search', 'files:read']), 'own', ['memories'], false)).toEqual({ status: 403, message: 'Missing permission: memories:read' });
  });

  it('a foreign Workspace is the generic 404 whatever else is missing, before type checks', () => {
    for (const held of [[], ['search'], [...PERMISSIONS]] as Permission[][]) {
      for (const types of typeSets) expect(attempt(keyWith(held), 'other', types, true)).toEqual({ status: 404 });
    }
    const a = (() => { try { service.authorizeSearch(keyWith([]), scopes.other, { types: ['files'], includeGlobal: false }); } catch (e) { return e as NotFoundException; } })();
    const b = (() => { try { service.authorizeSearch(keyWith([...PERMISSIONS]), workspaceScope('00000000-0000-4000-8000-0000000000ff'), { types: ['files'], includeGlobal: true }); } catch (e) { return e as NotFoundException; } })();
    expect(a!.getResponse()).toEqual(b!.getResponse());
  });

  it('fails closed on unknown principals, scopes and type sets', () => {
    for (const p of [null, undefined, {}, { kind: 'other' }, 'admin'] as unknown[]) {
      expect(() => service.authorizeSearch(p as Principal, scopes.global, { types: ['files'], includeGlobal: false })).toThrow(ForbiddenException);
      expect(() => service.authorizeSearch(p as Principal, scopes.own, { types: ['files'], includeGlobal: false })).toThrow(NotFoundException);
    }
    expect(() => service.authorizeSearch(ADMIN_PRINCIPAL, { kind: 'x' } as never, { types: ['files'], includeGlobal: false })).toThrow(ForbiddenException);
    for (const types of [[], ['chunks'], undefined, 'files'] as unknown[]) {
      expect(() => service.authorizeSearch(ADMIN_PRINCIPAL, scopes.own, { types, includeGlobal: false } as never)).toThrow(ForbiddenException);
    }
  });

  it('denials never contain ids, slugs or other keys\' data', () => {
    for (const where of ['own', 'global'] as const) {
      const got = attempt(keyWith([]), where, ['files', 'memories'], true);
      expect(JSON.stringify(got)).not.toMatch(new RegExp(`${OWN}|${OTHER}`));
    }
  });
});
