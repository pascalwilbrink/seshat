import type { Permission } from '@seshat/domain';

/**
 * Independent oracle for the authorization policy (AC-4 to AC-8), written out by hand from the specification.
 * It deliberately does NOT use getActionRequirement or the production mapping, so a wrong or changed mapping
 * fails the tests. Every catalog action must have an entry in EXPECTED (checked by the matrix specs).
 */
export type Kind = 'read' | 'write' | 'delete' | 'admin' | 'self';
export type Expected = {
  kind: Kind;
  permission?: Permission;
  /** Shared resources (Tags): any one of these suffices; `permission` is then the first of them. */
  anyOf?: Permission[];
  /** Resource families whose Global scope is concealed: no grant means the generic missing-resource 404. */
  concealed?: boolean;
  /** For a concealed mutation: the read permissions that let a key see Global at all (with global:read). */
  seesGlobalWith?: Permission[];
};
const FILE_READ = { concealed: true, seesGlobalWith: ['files:read'] } as const;
const COLLECTION_READ = { concealed: true, seesGlobalWith: ['collections:read'] } as const;
const MEMORY_READ = { concealed: true, seesGlobalWith: ['memories:read'] } as const;
const TAG_READ: Pick<Expected, 'concealed' | 'seesGlobalWith'> = { concealed: true, seesGlobalWith: ['files:read', 'memories:read'] };
export const EXPECTED: Record<string, Expected> = {
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
  'file.list': { kind: 'read', permission: 'files:read', ...FILE_READ },
  'file.get': { kind: 'read', permission: 'files:read', ...FILE_READ },
  'file.download': { kind: 'read', permission: 'files:read', ...FILE_READ },
  'file.upload': { kind: 'write', permission: 'files:write', ...FILE_READ },
  'file.update': { kind: 'write', permission: 'files:write', ...FILE_READ },
  'file.delete': { kind: 'delete', permission: 'files:delete', ...FILE_READ },
  'file.reindex': { kind: 'write', permission: 'files:write', ...FILE_READ },
  'file.chunks': { kind: 'read', permission: 'files:read', ...FILE_READ },
  'fileIndex:reindexScope': { kind: 'admin' },
  'collection.list': { kind: 'read', permission: 'collections:read', ...COLLECTION_READ },
  'collection.get': { kind: 'read', permission: 'collections:read', ...COLLECTION_READ },
  'collection.create': { kind: 'write', permission: 'collections:write', ...COLLECTION_READ },
  'collection.update': { kind: 'write', permission: 'collections:write', ...COLLECTION_READ },
  'collection.delete': { kind: 'write', permission: 'collections:write', ...COLLECTION_READ },
  'tag.list': { kind: 'read', permission: 'files:read', anyOf: ['files:read', 'memories:read'], ...TAG_READ },
  'tag.rename': { kind: 'write', permission: 'files:write', anyOf: ['files:write', 'memories:write'], ...TAG_READ },
  'tag.delete': { kind: 'write', permission: 'files:write', anyOf: ['files:write', 'memories:write'], ...TAG_READ },
  'memory.recall': { kind: 'read', permission: 'memories:read' },
  'memory.remember': { kind: 'write', permission: 'memories:write', ...MEMORY_READ },
  'memory.update': { kind: 'write', permission: 'memories:write', ...MEMORY_READ },
  'memory.forget': { kind: 'delete', permission: 'memories:delete', ...MEMORY_READ },
  'memory.supersede': { kind: 'write', permission: 'memories:write', ...MEMORY_READ },
  'search.query': { kind: 'read', permission: 'search' },
};

export type Outcome = { status: 'allow' } | { status: 403; message: string } | { status: 404 };

const needed = (e: Expected): Permission[] => e.anyOf ?? [e.permission!];

/** The specification's rules, independently stated. */
export function expectedOutcome(action: string, held: readonly Permission[], where: 'own' | 'other' | 'global'): Outcome {
  const e = EXPECTED[action]!;
  if (where === 'other') return { status: 404 }; // AC-5: indistinguishable from a missing Workspace, before any permission check
  if (where === 'own') {
    if (e.kind === 'admin' || e.kind === 'self') return { status: 403, message: 'Forbidden' }; // AC-7
    return needed(e).some((p) => held.includes(p))
      ? { status: 'allow' }
      : { status: 403, message: `Missing permission: ${needed(e).join(', ')}` }; // AC-4
  }
  // Global
  if (e.kind === 'self') return { status: 'allow' };
  if (e.concealed) {
    // Files, Collections and Tags: Global without the grant is the generic missing-resource 404; keys never mutate Global.
    const hasGrant = held.includes('global:read');
    if (e.kind === 'read') return hasGrant && needed(e).some((p) => held.includes(p)) ? { status: 'allow' } : { status: 404 };
    return hasGrant && e.seesGlobalWith!.some((p) => held.includes(p)) ? { status: 403, message: 'Forbidden' } : { status: 404 };
  }
  if (e.kind !== 'read') return { status: 403, message: 'Forbidden' }; // AC-6: never write, delete or manage
  const missing = [e.permission!, 'global:read' as Permission].filter((p) => !held.includes(p));
  return missing.length === 0 ? { status: 'allow' } : { status: 403, message: `Missing permission: ${missing.join(', ')}` };
}
