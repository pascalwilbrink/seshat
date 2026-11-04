import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const API_KEY_PREFIX_LENGTH = 8;
export const API_KEY_SECRET_LENGTH = 43; // 43 base62 characters ~ 256 bits
export const API_KEY_MIN_SECRET_LENGTH = 32;
export const API_KEY_MAX_LENGTH = 128;
export const API_KEY_DIGEST_BYTES = 32;

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
/** Largest multiple of 62 below 256: bytes at or above it are rejected so every character is equally likely. */
const REJECT_FROM = 248;

const KEY_RE = new RegExp(
  `^sk_seshat_([0-9A-Za-z]{${API_KEY_PREFIX_LENGTH}})_[0-9A-Za-z]{${API_KEY_MIN_SECRET_LENGTH},${API_KEY_MAX_LENGTH}}$`,
);

/** `length` base62 characters from the CSPRNG, by rejection sampling (no modulo bias). */
export function randomBase62(length: number, random: (n: number) => Buffer = randomBytes): string {
  let out = '';
  while (out.length < length) {
    for (const byte of random(Math.max(16, (length - out.length) * 2))) {
      if (byte >= REJECT_FROM) continue;
      out += BASE62[byte % 62];
      if (out.length === length) break;
    }
  }
  return out;
}

/** Generates a new key `sk_seshat_<prefix>_<secret>`. Returns the full key and its prefix; nothing is persisted here. */
export function generateApiKey(random: (n: number) => Buffer = randomBytes): { key: string; prefix: string } {
  const prefix = randomBase62(API_KEY_PREFIX_LENGTH, random);
  return { key: `sk_seshat_${prefix}_${randomBase62(API_KEY_SECRET_LENGTH, random)}`, prefix };
}

/** The prefix of a well-formed key, or null. Never echoes the input. */
export function parseApiKeyPrefix(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > API_KEY_MAX_LENGTH + 32) return null;
  return KEY_RE.exec(value)?.[1] ?? null;
}

/** HMAC-SHA-256 of the full key under the pepper: the only persisted representation of the secret. */
export function computeApiKeyHmac(pepper: string, key: string): Buffer {
  return createHmac('sha256', pepper).update(key, 'utf8').digest();
}

/**
 * Compares the HMAC of a presented key with a stored digest in constant time on two fixed-length (32 byte)
 * buffers. With no usable stored digest (unknown prefix, wrong length) it still compares against a dummy and
 * returns false. Non-string or oversized input is hashed as the empty string and rejected.
 */
export function verifyApiKey(pepper: string, presented: unknown, stored: Buffer | Uint8Array | null | undefined): boolean {
  const usable = typeof presented === 'string' && presented.length <= API_KEY_MAX_LENGTH + 32;
  const actual = computeApiKeyHmac(pepper, usable ? presented : '');
  const expected =
    stored && stored.length === API_KEY_DIGEST_BYTES ? Buffer.from(stored) : Buffer.alloc(API_KEY_DIGEST_BYTES);
  const equal = timingSafeEqual(actual, expected);
  return equal && usable && stored?.length === API_KEY_DIGEST_BYTES;
}
