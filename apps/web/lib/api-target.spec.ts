import { describe, expect, it } from 'vitest';
import { apiRewrites, resolveApiUrl } from './api-target';

describe('api target', () => {
  it('defaults to localhost:4200', () => {
    expect(resolveApiUrl({})).toBe('http://localhost:4200');
    expect(resolveApiUrl({ API_URL: '  ' })).toBe('http://localhost:4200');
  });
  it('honours API_URL and trims trailing slashes', () => {
    expect(resolveApiUrl({ API_URL: 'http://api.internal:9000/' })).toBe('http://api.internal:9000');
  });
  it('rewrites /api/* to the target', () => {
    expect(apiRewrites({ API_URL: 'http://x:1' })).toEqual([{ source: '/api/:path*', destination: 'http://x:1/api/:path*' }]);
  });
});
