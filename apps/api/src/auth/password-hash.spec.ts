import { describe, expect, it } from 'vitest';
import { isArgon2idHash } from '../config/app-config.js';
import { hashPassword, verifyPassword } from './password-hash.js';

describe('password hashing', () => {
  it('produces a salted argon2id hash that verifies', async () => {
    const [a, b] = await Promise.all([hashPassword('correct horse battery'), hashPassword('correct horse battery')]);
    expect(isArgon2idHash(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(await verifyPassword(a, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(a, 'wrong')).toBe(false);
  });

  it('returns false for a malformed hash instead of throwing', async () => {
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});
