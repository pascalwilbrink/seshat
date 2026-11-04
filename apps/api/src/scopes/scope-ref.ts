/** Scope of a resource: the explicit Global scope, or exactly one Workspace. Global is never a Workspace. */
export type ScopeRef = { kind: 'global' } | { kind: 'workspace'; workspaceId: string };

export const GLOBAL_SCOPE: ScopeRef = Object.freeze({ kind: 'global' }) as ScopeRef;

/** Canonical textual UUID (any version/variant), case-insensitive. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidScopeError extends Error {
  constructor(message = 'Invalid scope') {
    super(message);
    this.name = 'InvalidScopeError';
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function globalScope(): ScopeRef {
  return GLOBAL_SCOPE;
}

/** Workspace scope for a validated UUID (stored lowercase). Never reads implicit state. */
export function workspaceScope(workspaceId: unknown): ScopeRef {
  if (!isUuid(workspaceId)) throw new InvalidScopeError('workspaceId must be a UUID');
  return { kind: 'workspace', workspaceId: workspaceId.toLowerCase() };
}

/**
 * Parses an explicit scope: `{ scope: 'global' }` or `{ scope: 'workspace', workspaceId: <uuid> }`.
 * Ambiguous input (global with a workspaceId, workspace without one, extra keys, unknown scope) is rejected;
 * there is no default scope.
 */
export function parseScopeRef(input: unknown): ScopeRef {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new InvalidScopeError();
  }
  const record = input as Record<string, unknown>;
  const extra = Object.keys(record).filter((k) => k !== 'scope' && k !== 'workspaceId');
  if (extra.length > 0) throw new InvalidScopeError();
  if (record.scope === 'global') {
    if (record.workspaceId !== undefined && record.workspaceId !== null) throw new InvalidScopeError();
    return globalScope();
  }
  if (record.scope === 'workspace') return workspaceScope(record.workspaceId);
  throw new InvalidScopeError();
}

/** Column values for a scoped row: `workspace_id` is null exactly for Global. */
export function scopeColumns(scope: ScopeRef): { scope: 'global' | 'workspace'; workspaceId: string | null } {
  return scope.kind === 'global'
    ? { scope: 'global', workspaceId: null }
    : { scope: 'workspace', workspaceId: scope.workspaceId };
}
