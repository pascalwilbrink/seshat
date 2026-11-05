import { describe, expect, it } from 'vitest';
import type { MemoryDto } from './api-types';
import { EMPTY_FORM, buildCreateBody, buildUpdateBody, formFromMemory, parseTags, validateForm } from './memory-form';

const memory = { type: 'fact', content: 'c', title: 'T', metadata: { a: [1] }, confidence: 0.4, source: 's', tags: ['x'] } as unknown as MemoryDto;

describe('memory form helpers', () => {
  it('normalizes and de-duplicates tags', () => {
    expect(parseTags(' A, b ,a,,\nC ')).toEqual(['a', 'b', 'c']);
  });
  it('validates content, bounds, confidence and tags', () => {
    expect(validateForm({ ...EMPTY_FORM, content: '  ' }).content).toBeDefined();
    expect(validateForm({ ...EMPTY_FORM, content: 'x'.repeat(10001) }).content).toBeDefined();
    expect(validateForm({ ...EMPTY_FORM, content: 'x', title: 'y'.repeat(201), source: 'y'.repeat(501) })).toMatchObject({ title: expect.any(String), source: expect.any(String) });
    expect(validateForm({ ...EMPTY_FORM, content: 'x', confidence: '1.5' }).confidence).toBeDefined();
    expect(validateForm({ ...EMPTY_FORM, content: 'x', confidence: 'abc' }).confidence).toBeDefined();
    expect(validateForm({ ...EMPTY_FORM, content: 'x', tags: 'bad tag!' }).tags).toBeDefined();
    expect(validateForm({ ...EMPTY_FORM, content: 'x', confidence: '0.5', tags: 'ok-1, a:b' })).toEqual({});
  });
  it('POST omits empty optionals and never sends provenance', () => {
    expect(buildCreateBody({ ...EMPTY_FORM, content: 'x', tags: 'a' }, null)).toEqual({ type: 'fact', content: 'x', tags: ['a'] });
    expect(buildCreateBody({ ...EMPTY_FORM, content: 'x', title: 'T', confidence: '0', source: 's' }, 'p1')).toEqual({
      type: 'fact', content: 'x', tags: [], title: 'T', confidence: 0, source: 's', supersedes: 'p1',
    });
  });
  it('PUT is a full replacement with null clearing and metadata carried over', () => {
    const cleared = buildUpdateBody({ ...formFromMemory(memory), title: '', confidence: '', source: ' ', tags: '' }, memory);
    expect(cleared).toEqual({ type: 'fact', content: 'c', title: null, metadata: { a: [1] }, confidence: null, source: null, tags: [] });
    expect(Object.keys(cleared).sort()).toEqual(['confidence', 'content', 'metadata', 'source', 'tags', 'title', 'type']);
  });
});
