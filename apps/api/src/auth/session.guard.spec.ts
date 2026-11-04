import { describe, expect, it } from 'vitest';
import { PUBLIC_ROUTES, isPublicRoute } from './session.guard.js';

describe('public route allowlist', () => {
  it('contains exactly the two public method/path pairs', () => {
    expect(PUBLIC_ROUTES).toEqual([
      { method: 'GET', path: '/api/health' },
      { method: 'POST', path: '/api/auth/login' },
    ]);
  });

  it.each([
    ['GET', '/api/health', true],
    ['POST', '/api/auth/login', true],
    ['GET', '/api/health/', true],
    ['POST', '/api/health', false],
    ['GET', '/api/auth/login', false],
    ['DELETE', '/api/auth/login', false],
    ['POST', '/api/auth/logout', false],
    ['GET', '/api/auth/me', false],
    ['GET', '/', false],
    ['GET', '/api', false],
    ['GET', '/api/health/x', false],
    ['GET', '/API/HEALTH', false],
    ['GET', '/api/health//', false],
    ['GET', '/api/workspaces/00000000-0000-0000-0000-000000000000/overview', false],
  ])('%s %s -> public=%s', (method, path, expected) => {
    expect(isPublicRoute(method, path)).toBe(expected);
  });
});
