import { describe, expect, it } from 'vitest';
import { loginPath, safeLocalPath } from './safe-redirect';

describe('safeLocalPath', () => {
  it.each(['/a', '/a/b?x=1', '/'])('keeps %s', (p) => expect(safeLocalPath(p)).toBe(p));
  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', 'javascript:alert(1)', '', undefined, '/a\nb'])(
    'rejects %j',
    (p) => expect(safeLocalPath(p)).toBe('/'),
  );
  it('builds login paths with a local next only', () => {
    expect(loginPath('/x?y=1')).toBe('/login?next=%2Fx%3Fy%3D1');
    expect(loginPath('//evil.com')).toBe('/login');
  });
});
