import { describe, expect, it } from 'vitest';
import { LayoutDashboard, Sparkles } from 'lucide-react';
import { NAV_AREAS, NAV_GROUPS, areaFromPathname, areaHref, switchScopeHref, visibleGroups, type NavArea } from './navigation';

const G = { kind: 'global' } as const;
const W = { kind: 'workspace', slug: 'a' } as const;
const byId = (id: string) => NAV_AREAS.find((a) => a.id === id)!;

describe('navigation config', () => {
  it('declares the Knowledge, Developer and System groups with the specified areas', () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual(['Knowledge', 'Developer', 'System']);
    const labels = (g: string) => NAV_AREAS.filter((a) => a.group === g).map((a) => a.label);
    expect(labels('knowledge')).toEqual(['Overview', 'Files', 'Collections', 'Search', 'Memories']);
    expect(labels('developer')).toEqual(['API Keys', 'MCP']);
    expect(labels('system')).toEqual(['Settings']);
    expect(NAV_AREAS.filter((a) => a.group === 'developer').every((a) => a.scopes.length === 1 && a.scopes[0] === 'workspace')).toBe(true);
  });
  it('lists only Overview and Settings initially, in both scopes', () => {
    for (const scope of [G, W]) {
      expect(visibleGroups(scope).flatMap((g) => g.areas.map((a) => a.label))).toEqual(['Overview', 'Settings']);
    }
  });
  it('still resolves direct routes of unavailable areas', () => {
    expect(areaFromPathname('/w/a/files')?.id).toBe('files');
    expect(areaFromPathname('/global/collections')?.id).toBe('collections');
    expect(areaFromPathname('/w/a/api-keys')?.id).toBe('api-keys');
    expect(areaFromPathname('/global/api-keys')).toBeNull();
    expect(areaFromPathname('/login')).toBeNull();
  });
  it('keeps an applicable available area when switching, else falls back to Overview', () => {
    expect(switchScopeHref(W, byId('settings'))).toBe('/w/a/settings');
    expect(switchScopeHref(G, byId('settings'))).toBe('/global/settings');
    expect(switchScopeHref(W, byId('files'))).toBe('/w/a/overview'); // unavailable
    expect(switchScopeHref(G, byId('api-keys'))).toBe('/global/overview'); // Workspace-only
    expect(switchScopeHref(G, null)).toBe('/global/overview');
  });
});

describe('future extension needs only a config entry', () => {
  const extra: NavArea = { id: 'reports', label: 'Reports', group: 'knowledge', icon: Sparkles, route: 'reports', scopes: ['workspace'], available: true };
  const areas = [...NAV_AREAS, extra];
  it('shows, detects and switches to a new area without any other change', () => {
    expect(visibleGroups(W, areas)[0]!.areas.map((a) => a.id)).toContain('reports');
    expect(visibleGroups(G, areas)[0]!.areas.map((a) => a.id)).not.toContain('reports');
    expect(areaFromPathname('/w/a/reports', areas)).toBe(extra);
    expect(areaHref(W, extra)).toBe('/w/a/reports');
    expect(switchScopeHref(W, extra, areas)).toBe('/w/a/reports');
    expect(switchScopeHref(G, extra, areas)).toBe('/global/overview');
  });
  it('shows an existing area once its availability flag is switched on', () => {
    const on = areas.map((a) => (a.id === 'files' ? { ...a, available: true } : a));
    expect(visibleGroups(G, on)[0]!.areas.map((a) => a.label)).toEqual(['Overview', 'Files']);
    expect(switchScopeHref(W, on.find((a) => a.id === 'files')!, on)).toBe('/w/a/files');
  });
  it('uses a typed icon per area', () => {
    expect(byId('overview').icon).toBe(LayoutDashboard);
  });
});
