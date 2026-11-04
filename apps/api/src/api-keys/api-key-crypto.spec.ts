import { describe, expect, it, vi } from 'vitest';
import {
  API_KEY_DIGEST_BYTES,
  computeApiKeyHmac,
  generateApiKey,
  parseApiKeyPrefix,
  randomBase62,
  verifyApiKey,
} from './api-key-crypto.js';
import { GeneratedApiKey } from './api-key.store.js';

const PEPPER = 'unit-test-pepper-0123456789abcdefghij';

describe('generateApiKey', () => {
  it('has the sk_seshat_<8>_<>=32 base62> format', () => {
    for (let i = 0; i < 50; i++) {
      const { key, prefix } = generateApiKey();
      expect(key).toMatch(/^sk_seshat_[0-9A-Za-z]{8}_[0-9A-Za-z]{32,}$/);
      expect(prefix).toHaveLength(8);
      expect(key.startsWith(`sk_seshat_${prefix}_`)).toBe(true);
      expect(parseApiKeyPrefix(key)).toBe(prefix);
    }
  });

  it('is unique and draws from crypto.randomBytes', () => {
    const keys = new Set(Array.from({ length: 200 }, () => generateApiKey().key));
    expect(keys.size).toBe(200);
    const random = vi.fn((n: number) => Buffer.alloc(n, 1));
    generateApiKey(random);
    expect(random).toHaveBeenCalled();
  });
});

describe('randomBase62', () => {
  it('rejects biased bytes (>= 248) instead of wrapping them', () => {
    // 255s must be skipped; only the trailing bytes 0 and 61 contribute.
    const bytes = Buffer.concat([Buffer.alloc(40, 255), Buffer.from([0, 61]), Buffer.alloc(40, 255)]);
    const random = vi.fn().mockReturnValueOnce(bytes).mockReturnValue(Buffer.alloc(16, 63));
    expect(randomBase62(4, random)).toBe('0z11');
  });

  it('is evenly distributed over all 62 characters', () => {
    const counts = new Map<string, number>();
    for (const c of randomBase62(62 * 400)) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(62);
    for (const n of counts.values()) expect(n).toBeGreaterThan(400 * 0.6);
  });
});

describe('parseApiKeyPrefix', () => {
  const good = generateApiKey().key;
  it.each([
    ['empty', ''],
    ['wrong scheme', good.replace('sk_seshat_', 'sk_other_')],
    ['short secret', `sk_seshat_abcd1234_${'a'.repeat(31)}`],
    ['short prefix', `sk_seshat_abcd123_${'a'.repeat(40)}`],
    ['symbols', `sk_seshat_abcd1234_${'a'.repeat(39)}!`],
    ['huge', `sk_seshat_abcd1234_${'a'.repeat(100000)}`],
    ['trailing newline', `${good}\n`],
    ['number', 42],
    ['null', null],
    ['object', { toString: () => good }],
  ])('rejects %s', (_n, value) => {
    expect(parseApiKeyPrefix(value)).toBeNull();
  });
});

describe('HMAC verification', () => {
  const { key } = generateApiKey();
  const digest = computeApiKeyHmac(PEPPER, key);

  it('is a 32 byte HMAC-SHA-256 that depends on the pepper and the full key', () => {
    expect(digest).toHaveLength(API_KEY_DIGEST_BYTES);
    expect(computeApiKeyHmac(PEPPER, key).equals(digest)).toBe(true);
    expect(computeApiKeyHmac(`${PEPPER}x`, key).equals(digest)).toBe(false);
    expect(computeApiKeyHmac(PEPPER, `${key}x`).equals(digest)).toBe(false);
    expect(digest.toString('utf8')).not.toContain(key);
  });

  it('accepts the right key and rejects a wrong suffix, other pepper and other key', () => {
    expect(verifyApiKey(PEPPER, key, digest)).toBe(true);
    expect(verifyApiKey(PEPPER, `${key.slice(0, -1)}${key.endsWith('a') ? 'b' : 'a'}`, digest)).toBe(false);
    expect(verifyApiKey(`${PEPPER}x`, key, digest)).toBe(false);
    expect(verifyApiKey(PEPPER, generateApiKey().key, digest)).toBe(false);
  });

  it('handles malformed input without throwing', () => {
    for (const bad of [undefined, null, 5, {}, [], '', 'x'.repeat(100000)]) {
      expect(verifyApiKey(PEPPER, bad, digest)).toBe(false);
    }
    for (const stored of [null, undefined, Buffer.alloc(0), Buffer.alloc(31), Buffer.alloc(33), Buffer.alloc(32)]) {
      expect(verifyApiKey(PEPPER, key, stored)).toBe(false);
    }
  });

  it('an empty presented key never matches an all-zero or missing digest', () => {
    expect(verifyApiKey(PEPPER, '', Buffer.alloc(32))).toBe(false);
    expect(verifyApiKey(PEPPER, key, Buffer.alloc(32))).toBe(false);
  });

  it('accepts a Uint8Array digest', () => {
    expect(verifyApiKey(PEPPER, key, new Uint8Array(digest))).toBe(true);
  });
});

describe('GeneratedApiKey', () => {
  const record = {
    id: 'i', workspaceId: 'w', name: 'n', prefix: 'abcd1234', permissions: [], createdAt: new Date(),
    expiresAt: null, lastUsedAt: null, revokedAt: null,
  } as never;
  const secret = 'sk_seshat_abcd1234_SENTINELSECRETSENTINELSECRETSENTINEL';
  const g = new GeneratedApiKey(record, secret);

  it('exposes the secret only through the property', () => {
    expect(g.secret).toBe(secret);
    expect(JSON.stringify(g)).not.toContain('SENTINEL');
    expect(String(g)).not.toContain('SENTINEL');
    expect(`${g}`).not.toContain('SENTINEL');
    expect(Object.keys(g)).toEqual(['record']);
    expect(JSON.stringify({ ...g })).not.toContain('SENTINEL');
  });

  it('is redacted in util.inspect output', async () => {
    const { inspect } = await import('node:util');
    expect(inspect(g, { depth: 5, showHidden: true })).not.toContain('SENTINEL');
  });
});
