import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { renameTagSchema, tagNameSchema } from './tag.dto.js';
import { normalizeTagName, normalizeTagNames } from './tag-name.js';

describe('Tag name normalization', () => {
  it('trims and lowercases', () => {
    expect(normalizeTagName('  Project:ALPHA/v1.2_x-y  ')).toBe('project:alpha/v1.2_x-y');
    expect(tagNameSchema.parse('  Hello ')).toBe('hello');
  });

  it('accepts length 1 and 50 and rejects 0 and 51 (after trimming)', () => {
    expect(tagNameSchema.safeParse('a').success).toBe(true);
    expect(tagNameSchema.safeParse('a'.repeat(50)).success).toBe(true);
    expect(tagNameSchema.safeParse('a'.repeat(51)).success).toBe(false);
    expect(tagNameSchema.safeParse('   ').success).toBe(false);
    expect(tagNameSchema.safeParse('').success).toBe(false);
    expect(tagNameSchema.safeParse(` ${'a'.repeat(50)} `).success).toBe(true);
  });

  it.each(['a b', 'a,b', 'a#b', 'ä', 'a\nb', '<x>', 'a;b', 'a\\b', '日本', 'İ'])('rejects %j', (bad) => {
    expect(tagNameSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-strings and extra fields', () => {
    expect(tagNameSchema.safeParse(5).success).toBe(false);
    expect(renameTagSchema.safeParse({ name: 'ok', extra: 1 }).success).toBe(false);
    expect(renameTagSchema.parse({ name: 'OK' })).toEqual({ name: 'ok' });
  });

  it('deduplicates normalized names and keeps the first occurrence order', () => {
    expect(normalizeTagNames(['B', 'a', ' b ', 'A', 'c'])).toEqual(['b', 'a', 'c']);
    expect(normalizeTagNames([])).toEqual([]);
  });

  it('rejects the whole list on one bad name without echoing it', () => {
    for (const bad of [['ok', 'bad name'], ['ok', 3], 'ok', null, [''], ['x'.repeat(51)]]) {
      const run = () => normalizeTagNames(bad);
      expect(run).toThrow(BadRequestException);
    }
    try {
      normalizeTagNames(['SECRET VALUE']);
    } catch (e) {
      expect(JSON.stringify((e as BadRequestException).getResponse())).not.toContain('SECRET');
    }
  });
});
