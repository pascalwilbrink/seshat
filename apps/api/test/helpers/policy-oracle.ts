import type { Permission } from '@seshat/domain';

/**
 * Independent oracle for the authorization policy (AC-4 to AC-8), written out by hand from the specification.
 * It deliberately does NOT use getActionRequirement or the production mapping, so a wrong or changed mapping
 * fails the tests. Every catalog action must have an entry in EXPECTED (checked by the matrix specs).
 */
export type Kind = 'read' | 'write' | 'delete' | 'admin' | 'self';
export const EXPECTED: Record<string, { kind: Kind; permission?: Permission }> = {
  'session:read': { kind: 'self' },
  'session:end': { kind: 'admin' },
  'overview:read': { kind: 'admin' },
  'workspace:list': { kind: 'admin' },
  'workspace:create': { kind: 'admin' },
  'workspace:read': { kind: 'admin' },
  'workspace:update': { kind: 'admin' },
  'workspace:delete': { kind: 'admin' },
  'apiKey:list': { kind: 'admin' },
  'apiKey:create': { kind: 'admin' },
  'apiKey:update': { kind: 'admin' },
  'apiKey:revoke': { kind: 'admin' },
  'file.list': { kind: 'read', permission: 'files:read' },
  'file.get': { kind: 'read', permission: 'files:read' },
  'file.upload': { kind: 'write', permission: 'files:write' },
  'file.delete': { kind: 'delete', permission: 'files:delete' },
  'collection.list': { kind: 'read', permission: 'collections:read' },
  'collection.create': { kind: 'write', permission: 'collections:write' },
  'collection.update': { kind: 'write', permission: 'collections:write' },
  'memory.recall': { kind: 'read', permission: 'memories:read' },
  'memory.remember': { kind: 'write', permission: 'memories:write' },
  'memory.update': { kind: 'write', permission: 'memories:write' },
  'memory.forget': { kind: 'delete', permission: 'memories:delete' },
  'search.query': { kind: 'read', permission: 'search' },
};

export type Outcome = { status: 'allow' } | { status: 403; message: string } | { status: 404 };

/** The specification's rules, independently stated. */
export function expectedOutcome(action: string, held: readonly Permission[], where: 'own' | 'other' | 'global'): Outcome {
  const e = EXPECTED[action]!;
  if (where === 'other') return { status: 404 }; // AC-5: indistinguishable from a missing Workspace, before any permission check
  if (where === 'own') {
    if (e.kind === 'admin' || e.kind === 'self') return { status: 403, message: 'Forbidden' }; // AC-7
    return held.includes(e.permission!) ? { status: 'allow' } : { status: 403, message: `Missing permission: ${e.permission}` }; // AC-4
  }
  // Global
  if (e.kind === 'self') return { status: 'allow' };
  if (e.kind !== 'read') return { status: 403, message: 'Forbidden' }; // AC-6: never write, delete or manage
  const missing = [e.permission!, 'global:read' as Permission].filter((p) => !held.includes(p));
  return missing.length === 0 ? { status: 'allow' } : { status: 403, message: `Missing permission: ${missing.join(', ')}` };
}

