import { getActionRequirement, type Action, type Permission } from '@seshat/domain';

/**
 * Every Files, Collections and Tags endpoint the API implements, once per resource operation. The HTTP isolation
 * suite runs each entry in Global and in a Workspace, and `route-coverage.http.spec.ts` checks the table against the
 * routes Nest really registered, so an endpoint can neither escape the matrix nor linger in it after removal.
 */
export interface ScopedEndpoint {
  action: Action;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below the scope segment, with `:fileId`, `:collectionId` or `:tagId` when the route addresses a resource. */
  path: string;
  /** Permissions of the requirement. Several entries mean "any of" (shared Tags). */
  needs: readonly Permission[];
  /** Status of a successful call. */
  ok: 200 | 201 | 202 | 204;
  kind: 'read' | 'write';
}

export const SCOPED_ENDPOINTS: readonly ScopedEndpoint[] = [
  { action: 'file.upload', method: 'POST', path: 'files', needs: ['files:write'], ok: 201, kind: 'write' },
  { action: 'file.list', method: 'GET', path: 'files', needs: ['files:read'], ok: 200, kind: 'read' },
  { action: 'file.get', method: 'GET', path: 'files/:fileId', needs: ['files:read'], ok: 200, kind: 'read' },
  { action: 'file.download', method: 'GET', path: 'files/:fileId/download', needs: ['files:read'], ok: 200, kind: 'read' },
  { action: 'file.update', method: 'PUT', path: 'files/:fileId', needs: ['files:write'], ok: 200, kind: 'write' },
  { action: 'file.delete', method: 'DELETE', path: 'files/:fileId', needs: ['files:delete'], ok: 204, kind: 'write' },
  { action: 'file.reindex', method: 'POST', path: 'files/:fileId/reindex', needs: ['files:write'], ok: 202, kind: 'write' },
  { action: 'file.chunks', method: 'GET', path: 'files/:fileId/chunks', needs: ['files:read'], ok: 200, kind: 'read' },
  { action: 'collection.list', method: 'GET', path: 'collections', needs: ['collections:read'], ok: 200, kind: 'read' },
  { action: 'collection.create', method: 'POST', path: 'collections', needs: ['collections:write'], ok: 201, kind: 'write' },
  { action: 'collection.get', method: 'GET', path: 'collections/:collectionId', needs: ['collections:read'], ok: 200, kind: 'read' },
  { action: 'collection.update', method: 'PUT', path: 'collections/:collectionId', needs: ['collections:write'], ok: 200, kind: 'write' },
  { action: 'collection.delete', method: 'DELETE', path: 'collections/:collectionId', needs: ['collections:write'], ok: 204, kind: 'write' },
  { action: 'tag.list', method: 'GET', path: 'tags', needs: ['files:read', 'memories:read'], ok: 200, kind: 'read' },
  { action: 'tag.rename', method: 'PUT', path: 'tags/:tagId', needs: ['files:write', 'memories:write'], ok: 200, kind: 'write' },
  { action: 'tag.delete', method: 'DELETE', path: 'tags/:tagId', needs: ['files:write', 'memories:write'], ok: 204, kind: 'write' },
];

/** Admin-only scope-wide operations: no resource id and no key permission (keys are always refused). */
export const SCOPE_ADMIN_ENDPOINTS = [{ action: 'fileIndex:reindexScope', method: 'POST', path: 'files/reindex', ok: 202 }] as const;

/** The Express route strings (`METHOD /api/...`) this table stands for, in Global and in a Workspace. */
export function expectedRouteStrings(): string[] {
  return [...SCOPED_ENDPOINTS, ...SCOPE_ADMIN_ENDPOINTS].flatMap((e) => [`${e.method} /api/global/${e.path}`, `${e.method} /api/workspaces/:workspaceId/${e.path}`]).sort();
}

/** The table must agree with the shared action catalog, which the authorization service enforces. */
export function catalogMismatches(): string[] {
  const out: string[] = [];
  for (const e of SCOPED_ENDPOINTS) {
    const req = getActionRequirement(e.action) as { permission?: Permission; anyOf?: readonly Permission[]; classification?: string } | undefined;
    const needs = req?.anyOf ?? (req?.permission ? [req.permission] : []);
    if (JSON.stringify([...needs]) !== JSON.stringify([...e.needs])) out.push(`${e.action}: permissions`);
    const read = req?.classification === 'read';
    if (read !== (e.kind === 'read')) out.push(`${e.action}: classification`);
  }
  return out;
}
