import { describe, expect, it } from 'vitest';
import { LOGIN_LIMIT, LOGIN_WINDOW_MS, LoginRateLimiter } from './login-rate-limiter.js';

function setup() {
  let now = 1_000_000;
  const limiter = new LoginRateLimiter({ now: () => now });
  return { limiter, advance: (ms: number) => void (now += ms) };
}

describe('LoginRateLimiter', () => {
  it('allows 5 attempts per minute then blocks with a retry hint', () => {
    const { limiter } = setup();
    for (let i = 0; i < LOGIN_LIMIT; i++) expect(limiter.hit('1.1.1.1')).toBe(0);
    expect(limiter.hit('1.1.1.1')).toBeGreaterThan(0);
    expect(limiter.hit('1.1.1.1')).toBeGreaterThan(0);
  });

  it('tracks each IP separately', () => {
    const { limiter } = setup();
    for (let i = 0; i < LOGIN_LIMIT + 1; i++) limiter.hit('1.1.1.1');
    expect(limiter.hit('2.2.2.2')).toBe(0);
  });

  it('resets after the window', () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < LOGIN_LIMIT; i++) limiter.hit('a');
    expect(limiter.hit('a')).toBeGreaterThan(0);
    advance(LOGIN_WINDOW_MS);
    expect(limiter.hit('a')).toBe(0);
  });
});
