import type { OperationalPermission } from './permissions.js';

/**
 * How an action is classified:
 * - `read`:   only reads; may reach Global when the key also holds `global:read`.
 * - `write` / `delete`: mutate; never allowed in Global for API keys.
 * - `admin`:  admin-only (Workspace and key management); API keys are always denied.
 * - `self`:   a principal asking about its own identity (Global scope only); any authenticated principal.
 */
export type ActionClassification = 'read' | 'write' | 'delete' | 'admin' | 'self';

/**
 * - `permission`: the one operation permission an API key needs.
 * - `anyOf`: a key needs at least one of these (shared Tags: `files:read` OR `memories:read`).
 * - `concealGlobal`: a resource family whose Global scope is hidden. A key without the Global read grant
 *   (`global:read` plus a read permission of the family) gets the generic missing-resource 404 in Global instead of 403.
 */
export type ActionRequirement =
  | {
      readonly classification: 'read' | 'write' | 'delete';
      readonly permission: OperationalPermission;
      readonly concealGlobal?: true;
    }
  | {
      readonly classification: 'read' | 'write' | 'delete';
      readonly anyOf: readonly [OperationalPermission, ...OperationalPermission[]];
      readonly concealGlobal?: true;
    }
  | { readonly classification: 'admin' | 'self' };

const perm = (
  classification: 'read' | 'write' | 'delete',
  permission: OperationalPermission,
): ActionRequirement => ({ classification, permission });
/** A permission of a resource family whose Global scope is concealed (files, Collections, Tags). */
const res = (
  classification: 'read' | 'write' | 'delete',
  permission: OperationalPermission,
): ActionRequirement => ({ classification, permission, concealGlobal: true });
const resAny = (
  classification: 'read' | 'write' | 'delete',
  ...anyOf: [OperationalPermission, ...OperationalPermission[]]
): ActionRequirement => ({ classification, anyOf, concealGlobal: true });
const ADMIN: ActionRequirement = { classification: 'admin' };
const SELF: ActionRequirement = { classification: 'self' };

/**
 * The action catalog: every operation that needs an access decision, with an explicit classification.
 * There is no wildcard: a new action must be added here with a deliberate entry, otherwise it is denied.
 * Entries marked "future" (or whose endpoints are still in flight) describe operations later jobs implement.
 * `global:read` is a grant (see GLOBAL_READ_PERMISSION in permissions.ts), never the permission of an action.
 */
export const ACTION_CATALOG = {
  // Existing: session and Workspace management.
  'session:read': SELF,
  'session:end': ADMIN,
  'overview:read': ADMIN,
  'workspace:list': ADMIN,
  'workspace:create': ADMIN,
  'workspace:read': ADMIN,
  'workspace:update': ADMIN,
  'workspace:delete': ADMIN,
  // Existing in the next jobs: Workspace API-key management (never available to keys).
  'apiKey:list': ADMIN,
  'apiKey:create': ADMIN,
  'apiKey:update': ADMIN,
  'apiKey:revoke': ADMIN,
  // Files (concealGlobal: another scope or an ungranted Global is the generic missing-resource 404).
  'file.list': res('read', 'files:read'),
  'file.get': res('read', 'files:read'),
  'file.download': res('read', 'files:read'),
  'file.upload': res('write', 'files:write'),
  'file.update': res('write', 'files:write'),
  'file.delete': res('delete', 'files:delete'),
  // Ingestion: re-index one file (files:write), preview its chunks (files:read), re-index a whole scope (admin only).
  'file.reindex': res('write', 'files:write'),
  'file.chunks': res('read', 'files:read'),
  'fileIndex:reindexScope': ADMIN,
  // Collections: never grant access to files.
  'collection.list': res('read', 'collections:read'),
  'collection.get': res('read', 'collections:read'),
  'collection.create': res('write', 'collections:write'),
  'collection.update': res('write', 'collections:write'),
  'collection.delete': res('write', 'collections:write'),
  // Tags are shared by Files and (later) Memories: either side's permission is enough.
  'tag.list': resAny('read', 'files:read', 'memories:read'),
  'tag.rename': resAny('write', 'files:write', 'memories:write'),
  'tag.delete': resAny('write', 'files:write', 'memories:write'),
  // Memories: list/get (concealed Global), create (remember), full-replacement update, hard forget and the explicit post-create supersede state
  // change. Global is concealed like Files (an ungranted key gets the generic 404); keys never write Global.
  // `memory.recall` is future retrieval and keeps its plain permission mapping.
  'memory.recall': perm('read', 'memories:read'),
  'memory.list': res('read', 'memories:read'),
  'memory.get': res('read', 'memories:read'),
  'memory.remember': res('write', 'memories:write'),
  'memory.update': res('write', 'memories:write'),
  'memory.forget': res('delete', 'memories:delete'),
  'memory.supersede': res('write', 'memories:write'),
  // Future: search is a read operation.
  'search.query': perm('read', 'search'),
} as const satisfies Record<string, ActionRequirement>;

export type Action = keyof typeof ACTION_CATALOG;
export const ACTIONS = Object.freeze(Object.keys(ACTION_CATALOG) as Action[]);

export function isAction(value: unknown): value is Action {
  return typeof value === 'string' && Object.hasOwn(ACTION_CATALOG, value);
}

/** The requirement for an action, or `undefined` for anything not in the catalog (callers must fail closed). */
export function getActionRequirement(action: unknown): ActionRequirement | undefined {
  return isAction(action) ? ACTION_CATALOG[action] : undefined;
}
