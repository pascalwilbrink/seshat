import { describe, expect, it } from 'vitest';
import { CLEANUP_BACKOFF_MAX_SECONDS, cleanupBackoffSeconds } from './storage-cleanup.service.js';

describe('cleanupBackoffSeconds', () => {
  it('doubles from 5 seconds and is capped', () => {
    expect([1, 2, 3, 4].map(cleanupBackoffSeconds)).toEqual([5, 10, 20, 40]);
    expect(cleanupBackoffSeconds(50)).toBe(CLEANUP_BACKOFF_MAX_SECONDS);
    expect(cleanupBackoffSeconds(0)).toBe(5);
  });
});
