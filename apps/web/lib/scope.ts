export type Scope = { kind: 'global' } | { kind: 'workspace'; slug: string };
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

/** Builds a scoped route: /global/<route> or /w/<slug>/<route>. Which routes exist is declared in navigation.ts. */
export function scopeHref(scope: Scope, route: string): string {
  return scope.kind === 'global' ? `/global/${route}` : `/w/${encodeURIComponent(scope.slug)}/${route}`;
}
