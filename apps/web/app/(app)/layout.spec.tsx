import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const getSession = vi.fn();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));

import ProtectedLayout from './layout';
import Page from './page';

beforeEach(() => getSession.mockReset());

describe('protected layout', () => {
  it.each([['missing/invalid/expired', null]])('redirects to /login when the session is %s', async (_n, v) => {
    getSession.mockResolvedValue(v);
    await expect(ProtectedLayout({ children: null })).rejects.toThrow('REDIRECT:/login');
  });
  it('protects the root page: authenticated content renders, otherwise redirect', async () => {
    getSession.mockResolvedValue({ username: 'admin' });
    const html = renderToStaticMarkup(await ProtectedLayout({ children: <Page /> }));
    expect(html).toContain('<h1>Seshat</h1>');
    expect(html).toContain('admin');
    expect(html).not.toMatch(/session|cookie/i);
    getSession.mockResolvedValue(null);
    await expect(ProtectedLayout({ children: <Page /> })).rejects.toThrow('REDIRECT:/login');
  });
  it('is dynamic so sessions are never cached between users', async () => {
    const mod = await import('./layout');
    expect(mod.dynamic).toBe('force-dynamic');
  });
});
