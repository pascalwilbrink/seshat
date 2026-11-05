import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const getSession = vi.fn();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  usePathname: () => '/global/overview',
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import ProtectedLayout from './layout';
import Page from './page';
import { OverviewView } from '@/components/overview-view';

beforeEach(() => getSession.mockReset());

describe('protected layout', () => {
  it.each([['missing/invalid/expired', null]])('redirects to /login when the session is %s', async (_n, v) => {
    getSession.mockResolvedValue(v);
    await expect(ProtectedLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });
  it('redirects the authenticated root to Global Overview', () => {
    expect(() => Page()).toThrow('REDIRECT:/global/overview');
  });
  it('protects scoped pages: authenticated shell renders, otherwise redirect', async () => {
    getSession.mockResolvedValue({ username: 'admin' });
    const html = renderToStaticMarkup(await ProtectedLayout({ children: <OverviewView scope={{ kind: 'global' }} /> }));
    expect(html).toContain('Global');
    expect(html).toContain('admin');
    expect(html).not.toMatch(/session|cookie/i);
    getSession.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });
  it('renders the Overview inside the shell with its main landmark and skip link', async () => {
    getSession.mockResolvedValue({ username: 'admin' });
    const html = renderToStaticMarkup(await ProtectedLayout({ children: <OverviewView scope={{ kind: 'global' }} /> }));
    expect(html).toContain('id="main"');
    expect(html).toContain('Skip to content');
    expect(html).toContain('Overview');
  });
  it('is dynamic so sessions are never cached between users', async () => {
    const mod = await import('./layout');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
