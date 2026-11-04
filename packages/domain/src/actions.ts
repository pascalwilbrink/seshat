import type { OperationalPermission } from './permissions.js';

/**
 * How an action is classified:
 * - `read`:   only reads; may reach Global when the key also holds `global:read`.
 * - `write` / `delete`: mutate; never allowed in Global for API keys.
 * - `admin`:  admin-only (Workspace and key management); API keys are always denied.
 * - `self`:   a principal asking about its own identity (Global scope only); any authenticated principal.
 */
export type ActionClassification = 'read' | 'write' | 'delete' | 'admin' | 'self';

export type ActionRequirement =
  | { readonly classification: 'read' | 'write' | 'delete'; readonly permission: OperationalPermission }
  | { readonly classification: 'admin' | 'self' };

const perm = (
  classification: 'read' | 'write' | 'delete',
  permission: OperationalPermission,
): ActionRequirement => ({ classification, permission });
const ADMIN: ActionRequirement = { classification: 'admin' };
const SELF: ActionRequirement = { classification: 'self' };

/**
 * The action catalog: every operation that needs an access decision, with an explicit classification.
 * There is no wildcard: a new action must be added here with a deliberate entry, otherwise it is denied.
 * Entries marked "future" describe operations later specs implement; no endpoint exists for them yet.
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
  // Future: files.
  'file.list': perm('read', 'files:read'),
  'file.get': perm('read', 'files:read'),
  'file.upload': perm('write', 'files:write'),
  'file.delete': perm('delete', 'files:delete'),
  // Future: collections.
  'collection.list': perm('read', 'collections:read'),
  'collection.create': perm('write', 'collections:write'),
  'collection.update': perm('write', 'collections:write'),
  // Future: memories.
  'memory.recall': perm('read', 'memories:read'),
  'memory.remember': perm('write', 'memories:write'),
  'memory.update': perm('write', 'memories:write'),
  'memory.forget': perm('delete', 'memories:delete'),
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
