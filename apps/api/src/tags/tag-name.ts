import { BadRequestException } from '@nestjs/common';
import { TAG_NAME_MAX_LENGTH, TAG_NAME_PATTERN } from './tag.entity.js';

/** Trim and lowercase: the one normalization every Tag name goes through. */
export function normalizeTagName(raw: string): string {
  return raw.trim().toLowerCase();
}

/** True when an already normalized name satisfies length 1-50 and the allowed character set. */
export function isValidTagName(name: string): boolean {
  return name.length >= 1 && name.length <= TAG_NAME_MAX_LENGTH && TAG_NAME_PATTERN.test(name);
}

/**
 * Normalizes and validates a list of names and removes duplicates (first occurrence wins). The error names no
 * submitted value.
 */
export function normalizeTagNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new BadRequestException('Invalid tags');
  const out = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') throw new BadRequestException('Invalid tags');
    const name = normalizeTagName(item);
    if (!isValidTagName(name)) {
      throw new BadRequestException(
        `Tag names must be 1-${TAG_NAME_MAX_LENGTH} characters: letters, digits, "-", "_", ".", ":" and "/"`,
      );
    }
    out.add(name);
  }
  return [...out];
}
