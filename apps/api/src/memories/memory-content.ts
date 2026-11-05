import { createHash } from 'node:crypto';

/**
 * Content normalization and hashing policy for Memories (used for exact-duplicate detection).
 *
 * The normalized form of a content string is, in this order:
 *   1. Unicode NFC (canonically equivalent sequences become identical),
 *   2. every run of Unicode whitespace (`\s`, includes newlines and tabs) collapsed to one ASCII space,
 *   3. leading and trailing whitespace removed.
 * Case is preserved: "Use TLS" and "use tls" are different Memories. Punctuation and compatibility forms (NFKC) are
 * left alone on purpose.
 *
 * The content hash is the lowercase hex SHA-256 of the UTF-8 bytes of the normalized form. The type is NOT part of the
 * hash; uniqueness is enforced per (scope, type, hash) among active Memories. The original content is stored
 * unchanged; only the hash uses the normalized form.
 */
export function normalizeMemoryContent(content: string): string {
  return content.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

export function memoryContentHash(content: string): string {
  return createHash('sha256').update(normalizeMemoryContent(content), 'utf8').digest('hex');
}
