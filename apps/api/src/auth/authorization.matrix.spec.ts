import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { ACTION_CATALOG, ACTIONS, PERMISSIONS, type Action, type Permission } from '@seshat/domain';
import { AuthorizationService } from './authorization.service.js';
import type { Principal } from './principal.js';
import { EXPECTED, expectedOutcome, type Outcome } from '../../test/helpers/policy-oracle.js';
import { globalScope, workspaceScope } from '../scopes/scope-ref.js';

/**
 * AC-8: every permission x every catalog action x own Workspace / other Workspace / Global.
 * Expectations come from the hand-written oracle (test/helpers/policy-oracle.ts), never from the production
 * mapping. The catalog is iterated at runtime, so a new action or permission cannot silently escape this matrix.
 */

const OWN = '0b3d6f0e-6c2a-4a58-9f0e-3f1a2b3c4d5e';
const OTHER = '7c1d2e3f-0000-4000-8000-000000000001';
const service = new AuthorizationService();
const keyWith = (permissions: readonly Permission[]): Principal => ({ kind: 'apiKey', keyId: 'k', workspaceId: OWN, permissions });
const scopes = { own: workspaceScope(OWN), other: workspaceScope(OTHER), global: globalScope() };

/** Singleton, empty, full, and for each action the relevant missing-grant and dual-grant sets. */
function permissionSets(action: string): Array<[string, Permission[]]> {
  const e = EXPECTED[action]!;
  const sets: Array<[string, Permission[]]> = [['empty', []], ['all', [...PERMISSIONS]]];
  for (const p of PERMISSIONS) sets.push([`only ${p}`, [p]]);
  sets.push(['all but global:read', PERMISSIONS.filter((p) => p !== 'global:read')]);
  if (e.permission) {
    sets.push(['all but required', PERMISSIONS.filter((p) => p !== e.permission)]);
    sets.push(['required + global:read', [e.permission, 'global:read']]);
    sets.push(['all but required and global:read', PERMISSIONS.filter((p) => p !== e.permission && p !== 'global:read')]);
  }
  return sets;
}

function run(principal: Principal, action: string, where: 'own' | 'other' | 'global'): Outcome {
  try {
    service.assertCan(principal, action as Action, scopes[where]);
    return { status: 'allow' };
  } catch (err) {
    if (err instanceof NotFoundException) {
      expect(err.getResponse()).toEqual(new NotFoundException('Not Found').getResponse());
      return { status: 404 };
    }
    if (err instanceof ForbiddenException) return { status: 403, message: err.message };
    throw err;
  }
}

describe('policy matrix: the independent table covers the shared catalog exactly', () => {
  it('has an entry for every catalog action and no stale entries', () => {
    expect([...ACTIONS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it('agrees with the catalog on the classification and permission of every action', () => {
    for (const action of ACTIONS) {
      const catalog = ACTION_CATALOG[action] as { classification: string; permission?: string };
      expect(catalog.classification, action).toBe(EXPECTED[action]!.kind);
      expect(catalog.permission, action).toBe(EXPECTED[action]!.permission);
    }
  });

  it('keeps the permission list to the specified ten and one global grant', () => {
    expect([...PERMISSIONS].sort()).toEqual(
      ['collections:read', 'collections:write', 'files:delete', 'files:read', 'files:write', 'global:read', 'memories:delete', 'memories:read', 'memories:write', 'search'],
    );
  });

  it('only maps operations to catalogued permissions and never maps global:read as an operation permission', () => {
    for (const e of Object.values(EXPECTED)) {
      if (e.permission) expect(PERMISSIONS).toContain(e.permission);
      expect(e.permission).not.toBe('global:read');
    }
    // Every operational permission is exercised by at least one action (no dead permission).
    const used = new Set(Object.values(EXPECTED).map((e) => e.permission));
    for (const p of PERMISSIONS.filter((x) => x !== 'global:read')) expect(used.has(p), p).toBe(true);
  });

  it('treats search as a read operation', () => {
    expect(EXPECTED['search.query']!.kind).toBe('read');
    expect(ACTION_CATALOG['search.query'].classification).toBe('read');
  });
});

describe('policy matrix: API key principal', () => {
  for (const action of ACTIONS) {
    describe(action, () => {
      for (const where of ['own', 'other', 'global'] as const) {
        for (const [label, held] of permissionSets(action)) {
          it(`${where}: ${label}`, () => {
            const want = expectedOutcome(action, held, where);
            const got = run(keyWith(held), action, where);
            expect(got).toEqual(want);
            expect(service.can(keyWith(held), action, scopes[where])).toBe(want.status === 'allow');
          });
        }
      }
    });
  }

  it('crosses every single permission with every action in all three scopes (cardinality guard)', () => {
    let cases = 0;
    for (const action of ACTIONS) {
      for (const where of ['own', 'other', 'global'] as const) {
        for (const p of PERMISSIONS) {
          expect(run(keyWith([p]), action, where)).toEqual(expectedOutcome(action, [p], where));
          cases++;
        }
      }
    }
    expect(cases).toBe(ACTIONS.length * 3 * PERMISSIONS.length);
  });

  it('never allows a write, delete or admin action in Global, even with every permission', () => {
    for (const action of ACTIONS) {
      if (['read', 'self'].includes(EXPECTED[action]!.kind)) continue;
      expect(service.can(keyWith(PERMISSIONS), action, scopes.global), action).toBe(false);
    }
  });

  it('never allows an admin-only action to a key, in any scope, with every permission', () => {
    for (const action of ACTIONS) {
      if (EXPECTED[action]!.kind !== 'admin') continue;
      for (const where of ['own', 'other', 'global'] as const) expect(service.can(keyWith(PERMISSIONS), action, scopes[where]), `${action} ${where}`).toBe(false);
    }
  });

  it('requires both the operation permission and global:read for a Global read', () => {
    for (const action of ACTIONS) {
      const e = EXPECTED[action]!;
      if (e.kind !== 'read') continue;
      expect(service.can(keyWith([e.permission!, 'global:read']), action, scopes.global), action).toBe(true);
      expect(service.can(keyWith([e.permission!]), action, scopes.global), action).toBe(false);
      expect(service.can(keyWith(['global:read']), action, scopes.global), action).toBe(false);
      expect(service.can(keyWith(PERMISSIONS.filter((p) => p !== e.permission)), action, scopes.global), action).toBe(false);
    }
  });

  it('does not grant Global through global:read alone for any action except identity', () => {
    for (const action of ACTIONS) {
      expect(service.can(keyWith(['global:read']), action, scopes.global), action).toBe(action === 'session:read');
    }
  });

  it('403s name only permission identifiers and carry no Workspace id', () => {
    for (const action of ACTIONS) {
      for (const where of ['own', 'global'] as const) {
        const out = run(keyWith([]), action, where);
        if (out.status !== 403) continue;
        expect(out.message).toMatch(/^(Forbidden|Missing permission: [a-z:]+(, [a-z:]+)*)$/);
        expect(out.message).not.toContain(OWN);
      }
    }
  });

  it('fails closed on empty runtime sets, unknown actions, unknown permissions and malformed principals', () => {
    for (const where of ['own', 'other', 'global'] as const) {
      expect(service.can(keyWith([]), 'file.list', scopes[where])).toBe(false);
      for (const action of ['file.explode', '', '__proto__', 'constructor', 'toString', 'file.list '] as const) {
        expect(service.can(keyWith(PERMISSIONS), action as Action, scopes[where]), action).toBe(false);
      }
    }
    const bad: unknown[] = [
      { kind: 'apiKey', keyId: 'k', workspaceId: OWN, permissions: ['files:read', 'files:everything'] },
      { kind: 'apiKey', keyId: 'k', workspaceId: OWN, permissions: 'files:read' },
      { kind: 'apiKey', keyId: 'k', workspaceId: 'not-a-uuid', permissions: ['files:read'] },
      { kind: 'apiKey', permissions: ['files:read'], workspaceId: OWN },
    ];
    for (const principal of bad) {
      expect(service.can(principal as Principal, 'file.list', scopes.own)).toBe(false);
      expect(service.can(principal as Principal, 'file.list', scopes.global)).toBe(false);
    }
  });

  it('answers unknown actions in a Workspace with the same 404 as a foreign Workspace', () => {
    expect(run(keyWith(PERMISSIONS), 'file.explode', 'own')).toEqual({ status: 404 });
  });
});

describe('policy matrix: admin principal', () => {
  it.each(ACTIONS)('allows %s in every scope', (action) => {
    for (const where of ['own', 'other', 'global'] as const) expect(run({ kind: 'admin' }, action, where)).toEqual({ status: 'allow' });
  });
});
