export type Scope = { kind: 'global' } | { kind: 'workspace'; slug: string };
export type Section = 'overview' | 'settings';

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
  return (parts[0] === 'w' ? parts[2] : parts[1]) === 'settings' ? 'settings' : 'overview';
}

export function scopeHref(scope: Scope, section: Section): string {
  return scope.kind === 'global' ? `/global/${section}` : `/w/${encodeURIComponent(scope.slug)}/${section}`;
}
