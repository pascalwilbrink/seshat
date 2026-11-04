import { describe, expect, it } from 'vitest';
import { scopeFromPathname, scopeHref, sectionFromPathname } from './scope';

describe('scope from URL', () => {
  it.each([
    ['/global/overview', { kind: 'global' }],
    ['/global/settings', { kind: 'global' }],
    ['/w/acme/overview', { kind: 'workspace', slug: 'acme' }],
    ['/w/acme/settings', { kind: 'workspace', slug: 'acme' }],
    ['/w/%E0%A4%A/overview', null],
    ['/w', null],
    ['/', null],
    ['/login', null],
  ])('%s', (path, expected) => expect(scopeFromPathname(path)).toEqual(expected));
  it('derives section and hrefs', () => {
    expect(sectionFromPathname('/w/a/settings')).toBe('settings');
    expect(sectionFromPathname('/global/overview')).toBe('overview');
    expect(scopeHref({ kind: 'global' }, 'settings')).toBe('/global/settings');
    expect(scopeHref({ kind: 'workspace', slug: 'a-b' }, 'overview')).toBe('/w/a-b/overview');
  });
});
