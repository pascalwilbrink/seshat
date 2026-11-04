/**
 * The fixed set of API-key permissions. Defined once here and shared by the API, MCP and the web UI.
 * Do not copy these strings elsewhere: import them.
 */
export const PERMISSIONS = [
  'files:read',
  'files:write',
  'files:delete',
  'collections:read',
  'collections:write',
  'memories:read',
  'memories:write',
  'memories:delete',
  'search',
  'global:read',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

/** The grant that lets a read through to Global. It never authorizes an operation on its own. */
export const GLOBAL_READ_PERMISSION = 'global:read' as const satisfies Permission;

/** Permissions that authorize an operation directly (everything except the `global:read` grant). */
export type OperationalPermission = Exclude<Permission, typeof GLOBAL_READ_PERMISSION>;
export const OPERATIONAL_PERMISSIONS: readonly OperationalPermission[] = PERMISSIONS.filter(
  (p): p is OperationalPermission => p !== GLOBAL_READ_PERMISSION,
);

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}

/** Runtime validation for stored or submitted permission lists: an array of known, distinct permissions. */
export function parsePermissions(value: unknown): Permission[] | null {
  if (!Array.isArray(value)) return null;
  const out: Permission[] = [];
  for (const item of value) {
    if (!isPermission(item)) return null;
    if (!out.includes(item)) out.push(item);
  }
  return out;
}

export interface PermissionArea {
  readonly id: 'files' | 'collections' | 'memories' | 'search' | 'global';
  readonly label: string;
  readonly permissions: readonly Permission[];
}

/** Display grouping for the UI. Every permission is in exactly one area (checked by tests). */
export const PERMISSION_AREAS: readonly PermissionArea[] = [
  { id: 'files', label: 'Files', permissions: ['files:read', 'files:write', 'files:delete'] },
  { id: 'collections', label: 'Collections', permissions: ['collections:read', 'collections:write'] },
  { id: 'memories', label: 'Memories', permissions: ['memories:read', 'memories:write', 'memories:delete'] },
  { id: 'search', label: 'Search', permissions: ['search'] },
  { id: 'global', label: 'Global knowledge', permissions: ['global:read'] },
];
