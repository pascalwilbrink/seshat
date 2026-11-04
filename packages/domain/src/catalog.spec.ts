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
      if (req!.classification === 'admin' || req!.classification === 'self') expect('permission' in req!).toBe(false);
      else expect(isPermission((req as { permission: unknown }).permission)).toBe(true);
    }
  });

  it('maps every operational permission to at least one action, and none to global:read', () => {
    const used = new Set<string>(Object.values(ACTION_CATALOG).flatMap((r) => ('permission' in r ? [r.permission] : [])));
    for (const p of OPERATIONAL_PERMISSIONS) expect(used.has(p), p).toBe(true);
    expect(used.has(GLOBAL_READ_PERMISSION)).toBe(false);
  });

  it('matches the naming of the spec examples and keeps search a read', () => {
    expect(getActionRequirement('file.upload')).toEqual({ classification: 'write', permission: 'files:write' });
    expect(getActionRequirement('memory.forget')).toEqual({ classification: 'delete', permission: 'memories:delete' });
    expect(getActionRequirement('search.query')).toEqual({ classification: 'read', permission: 'search' });
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
