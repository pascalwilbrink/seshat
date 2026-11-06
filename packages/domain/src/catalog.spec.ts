import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  ACTION_CATALOG,
  GLOBAL_READ_PERMISSION,
  OPERATIONAL_PERMISSIONS,
  PERMISSIONS,
  PERMISSION_AREAS,
  getActionRequirement,
  isAction,
  isPermission,
  parsePermissions,
} from './index.js';

describe('permission catalog', () => {
  it('contains exactly the ten specified permissions', () => {
    expect([...PERMISSIONS]).toEqual([
      'files:read', 'files:write', 'files:delete',
      'collections:read', 'collections:write',
      'memories:read', 'memories:write', 'memories:delete',
      'search', 'global:read',
    ]);
  });

  it('validates permissions at runtime', () => {
    expect(isPermission('files:read')).toBe(true);
    for (const bad of ['files:admin', 'FILES:READ', '', null, undefined, 3, {}]) expect(isPermission(bad)).toBe(false);
    expect(parsePermissions(['search', 'search', 'files:read'])).toEqual(['search', 'files:read']);
    expect(parsePermissions(['search', 'nope'])).toBeNull();
    expect(parsePermissions('search')).toBeNull();
  });

  it('puts every permission in exactly one display area', () => {
    const listed = PERMISSION_AREAS.flatMap((a) => [...a.permissions]);
    expect([...listed].sort()).toEqual([...PERMISSIONS].sort());
  });

  it('keeps global:read out of the operational permissions', () => {
    expect(OPERATIONAL_PERMISSIONS).not.toContain(GLOBAL_READ_PERMISSION);
    expect(OPERATIONAL_PERMISSIONS).toHaveLength(9);
  });
});

describe('action catalog', () => {
  it('classifies every action explicitly', () => {
    for (const action of ACTIONS) {
      const req = getActionRequirement(action);
      expect(req, action).toBeDefined();
      expect(['read', 'write', 'delete', 'admin', 'self']).toContain(req!.classification);
      if (req!.classification === 'admin' || req!.classification === 'self') expect('permission' in req! || 'anyOf' in req!).toBe(false);
      else {
        const r = req as { permission?: unknown; anyOf?: unknown[] };
        for (const p of r.anyOf ?? [r.permission]) expect(isPermission(p), action).toBe(true);
      }
    }
  });

  it('maps every operational permission to at least one action, and none to global:read', () => {
    const used = new Set<string>(Object.values(ACTION_CATALOG).flatMap((r) => ('permission' in r ? [r.permission] : 'anyOf' in r ? [...r.anyOf] : [])));
    for (const p of OPERATIONAL_PERMISSIONS) expect(used.has(p), p).toBe(true);
    expect(used.has(GLOBAL_READ_PERMISSION)).toBe(false);
  });

  it('matches the naming of the spec examples and keeps search a read', () => {
    expect(getActionRequirement('file.upload')).toEqual({ classification: 'write', permission: 'files:write', concealGlobal: true });
    expect(getActionRequirement('memory.forget')).toEqual({ classification: 'delete', permission: 'memories:delete', concealGlobal: true });
    expect(getActionRequirement('search.query')).toEqual({ classification: 'read', permission: 'search' });
  });

  it('maps every planned Files operation to files:read, files:write or files:delete', () => {
    const files = {
      'file.list': 'files:read',
      'file.get': 'files:read',
      'file.download': 'files:read',
      'file.upload': 'files:write',
      'file.update': 'files:write',
      'file.delete': 'files:delete',
      'file.reindex': 'files:write',
      'file.chunks': 'files:read',
    } as const;
    for (const [action, permission] of Object.entries(files)) {
      expect(getActionRequirement(action), action).toMatchObject({ permission });
    }
    expect(ACTIONS.filter((a) => a.startsWith('file.')).sort()).toEqual(Object.keys(files).sort());
  });

  it('keeps re-indexing a whole scope admin-only', () => {
    expect(getActionRequirement('fileIndex:reindexScope')).toEqual({ classification: 'admin' });
  });

  it('maps Collection operations to collections:read or collections:write', () => {
    for (const a of ['collection.list', 'collection.get']) expect(getActionRequirement(a)).toMatchObject({ classification: 'read', permission: 'collections:read' });
    for (const a of ['collection.create', 'collection.update', 'collection.delete']) expect(getActionRequirement(a)).toMatchObject({ classification: 'write', permission: 'collections:write' });
  });

  it('lets either side of the shared Tags use them: files OR memories', () => {
    expect(getActionRequirement('tag.list')).toEqual({ classification: 'read', anyOf: ['files:read', 'memories:read'], concealGlobal: true });
    for (const a of ['tag.rename', 'tag.delete']) {
      expect(getActionRequirement(a)).toEqual({ classification: 'write', anyOf: ['files:write', 'memories:write'], concealGlobal: true });
    }
  });

  it('conceals Global for every files, Collections and Tags action and the Memory write actions, and for nothing else', () => {
    for (const action of ACTIONS) {
      const req = getActionRequirement(action) as { concealGlobal?: boolean };
      expect(Boolean(req.concealGlobal), action).toBe(/^(file|collection|tag)\./.test(action) || /^memory\.(list|get|remember|update|forget|supersede)$/.test(action));
    }
  });

  it('keeps Workspace and key management admin-only', () => {
    for (const a of ACTIONS.filter((x) => x.startsWith('workspace:') || x.startsWith('apiKey:') || x === 'overview:read')) {
      expect(getActionRequirement(a)?.classification, a).toBe('admin');
    }
  });

  it('fails closed for unknown actions, including prototype names', () => {
    for (const a of ['nope', '', 'toString', '__proto__', 'constructor', null, undefined, 1]) {
      expect(isAction(a)).toBe(false);
      expect(getActionRequirement(a)).toBeUndefined();
    }
  });
});

describe('MCP tool requirements', () => {
  it('evaluates allOf and anyOf requirements', async () => {
    const { satisfiesToolRequirement, missingToolPermissions, mcpAnnotationsFor } = await import('./mcp-tools.js');
    expect(satisfiesToolRequirement({ allOf: ['search', 'files:read'] }, ['search', 'files:read'])).toBe(true);
    expect(missingToolPermissions({ allOf: ['search', 'files:read'] }, ['search'])).toEqual(['files:read']);
    expect(satisfiesToolRequirement({ anyOf: ['files:read', 'memories:read'] }, ['memories:read'])).toBe(true);
    expect(missingToolPermissions({ anyOf: ['files:read', 'memories:read'] }, ['search'])).toEqual(['files:read', 'memories:read']);
    expect(satisfiesToolRequirement({ allOf: ['files:read'] }, ['global:read'])).toBe(false);
    expect(mcpAnnotationsFor('read')).toEqual({ readOnlyHint: true, destructiveHint: false });
    expect(mcpAnnotationsFor('write')).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(mcpAnnotationsFor('destructive')).toEqual({ readOnlyHint: false, destructiveHint: true });
  });
});
