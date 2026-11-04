import { Inject, Injectable } from '@nestjs/common';

export const LOGIN_LIMIT = 5;
export const LOGIN_WINDOW_MS = 60_000;
const MAX_TRACKED_KEYS = 10_000;

/** Time source, replaceable in tests. */
export const CLOCK = Symbol('CLOCK');
export interface Clock {
  now(): number;
}
export const systemClock: Clock = { now: () => Date.now() };

/** In-memory sliding-window limiter: at most 5 login attempts per key (client IP) per minute. */
@Injectable()
export class LoginRateLimiter {
  private readonly attempts = new Map<string, number[]>();

  constructor(@Inject(CLOCK) private readonly clock: Clock) {}

  /** Records an attempt. Returns 0 when allowed, otherwise the seconds until a retry is possible. */
  hit(key: string): number {
    const now = this.clock.now();
    const recent = (this.attempts.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
    if (recent.length >= LOGIN_LIMIT) {
      this.attempts.set(key, recent);
      return Math.max(1, Math.ceil((recent[0]! + LOGIN_WINDOW_MS - now) / 1000));
    }
    recent.push(now);
    this.attempts.delete(key);
    this.attempts.set(key, recent);
    if (this.attempts.size > MAX_TRACKED_KEYS) this.prune(now);
    return 0;
  }

  private prune(now: number): void {
    for (const [key, times] of this.attempts) {
      if (times.every((t) => now - t >= LOGIN_WINDOW_MS)) this.attempts.delete(key);
    }
    // Still too many live keys: drop the oldest-inserted ones.
    for (const key of this.attempts.keys()) {
      if (this.attempts.size <= MAX_TRACKED_KEYS) break;
      this.attempts.delete(key);
    }
  }
}
