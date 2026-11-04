export type Scope = { kind: 'global' } | { kind: 'workspace'; slug: string };
export type Section = 'overview' | 'collections' | 'settings' | 'api-keys';

/** Sections that exist in a Workspace only. There is no Global API-key page. */
export const WORKSPACE_ONLY_SECTIONS: readonly Section[] = ['api-keys'];

export const GLOBAL_OVERVIEW_PATH = '/global/overview';

/** The URL is the source of truth: /global/... or /w/<slug>/... Anything else has no active scope. */
export function scopeFromPathname(pathname: string | null): Scope | null {
  const parts = (pathname ?? '').split('/').filter(Boolean);
  if (parts[0] === 'global') return { kind: 'global' };
  if (parts[0] === 'w' && parts[1]) {
    try {
      return { kind: 'workspace', slug: decodeURIComponent(parts[1]) };
    } catch {
      return null;
    }
  }
  return null;
}

export function sectionFromPathname(pathname: string | null): Section {
  const parts = (pathname ?? '').split('/').filter(Boolean);
  const raw = parts[0] === 'w' ? parts[2] : parts[1];
  if (raw === 'settings') return 'settings';
  if (raw === 'collections') return 'collections';
  if (raw === 'api-keys' && parts[0] === 'w') return 'api-keys';
  return 'overview';
}

export function scopeHref(scope: Scope, section: Section): string {
  if (scope.kind === 'global' && WORKSPACE_ONLY_SECTIONS.includes(section)) return '/global/overview';
  return scope.kind === 'global' ? `/global/${section}` : `/w/${encodeURIComponent(scope.slug)}/${section}`;
}
