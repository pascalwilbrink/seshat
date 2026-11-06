import { Brain, FileText, FolderOpen, KeyRound, LayoutDashboard, Plug, Search, Settings, type LucideIcon } from 'lucide-react';
import { scopeHref, type Scope } from './scope';

export type ScopeKind = Scope['kind'];
export type NavGroupId = 'knowledge' | 'developer' | 'system';

export interface NavGroup {
  id: NavGroupId;
  label: string;
}

export interface NavArea {
  id: string;
  label: string;
  group: NavGroupId;
  icon: LucideIcon;
  /** Route pattern below the scope: /global/<route> or /w/<slug>/<route>. */
  route: string;
  /** Scopes in which this area exists. */
  scopes: readonly ScopeKind[];
  /** Only available areas are listed in the navigation; the route of an unavailable area keeps working. */
  available: boolean;
}

export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'knowledge', label: 'Knowledge' },
  { id: 'developer', label: 'Developer' },
  { id: 'system', label: 'System' },
];

/**
 * The one place that declares navigation. To add an area, add an entry here and create its route.
 * Overview, Search, Memories, MCP and Settings are listed for now; Files, Collections and
 * API Keys keep their direct routes but are not listed.
 */
export const NAV_AREAS: readonly NavArea[] = [
  { id: 'overview', label: 'Overview', group: 'knowledge', icon: LayoutDashboard, route: 'overview', scopes: ['global', 'workspace'], available: true },
  { id: 'files', label: 'Files', group: 'knowledge', icon: FileText, route: 'files', scopes: ['global', 'workspace'], available: false },
  { id: 'collections', label: 'Collections', group: 'knowledge', icon: FolderOpen, route: 'collections', scopes: ['global', 'workspace'], available: false },
  { id: 'search', label: 'Search', group: 'knowledge', icon: Search, route: 'search', scopes: ['global', 'workspace'], available: true },
  { id: 'memories', label: 'Memories', group: 'knowledge', icon: Brain, route: 'memories', scopes: ['global', 'workspace'], available: true },
  { id: 'api-keys', label: 'API Keys', group: 'developer', icon: KeyRound, route: 'api-keys', scopes: ['workspace'], available: false },
  { id: 'mcp', label: 'MCP', group: 'developer', icon: Plug, route: 'mcp', scopes: ['workspace'], available: true },
  { id: 'settings', label: 'Settings', group: 'system', icon: Settings, route: 'settings', scopes: ['global', 'workspace'], available: true },
];

export const DEFAULT_AREA_ID = 'overview';

export function appliesTo(area: NavArea, scope: Scope): boolean {
  return area.scopes.includes(scope.kind);
}

/** Matches the URL against every declared area (also unavailable ones, whose routes still exist). */
export function areaFromPathname(pathname: string | null, areas: readonly NavArea[] = NAV_AREAS): NavArea | null {
  const parts = (pathname ?? '').split('/').filter(Boolean);
  const raw = parts[0] === 'w' ? parts[2] : parts[0] === 'global' ? parts[1] : undefined;
  const area = areas.find((a) => a.route === raw);
  return area && (parts[0] === 'w' ? area.scopes.includes('workspace') : area.scopes.includes('global')) ? area : null;
}

export function areaHref(scope: Scope, area: NavArea): string {
  return scopeHref(scope, area.route);
}

/** Available areas for a scope, grouped in declaration order of NAV_GROUPS; empty groups are dropped. */
export function visibleGroups(scope: Scope, areas: readonly NavArea[] = NAV_AREAS, groups: readonly NavGroup[] = NAV_GROUPS) {
  return groups
    .map((group) => ({ group, areas: areas.filter((a) => a.group === group.id && a.available && appliesTo(a, scope)) }))
    .filter((g) => g.areas.length > 0);
}

/** Where switching to `target` goes: the current area when it applies there and is available, else Overview. */
export function switchScopeHref(target: Scope, current: NavArea | null, areas: readonly NavArea[] = NAV_AREAS): string {
  const keep = current && current.available && appliesTo(current, target) ? current : null;
  const fallback = areas.find((a) => a.id === DEFAULT_AREA_ID) ?? areas[0]!;
  return areaHref(target, keep ?? fallback);
}
