import { describe, expect, it } from 'vitest';
import type { ChunkSearchResultDto, MemorySearchResultDto } from './api-types';
import { describeLocation, excerpt, highlightSegments, parseFileFocus, parseMemoryFocus, queryTerms, resultHref } from './search';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const base = { score: 0.03, vectorRank: 1, keywordRank: 1, content: 'x' };
const chunk = (scope: ChunkSearchResultDto['scope']): ChunkSearchResultDto => ({
  ...base, kind: 'chunk', id: U2, scope, file: { id: U1, name: 'a.md' }, collectionId: null, ordinal: 3,
  location: { startOffset: 0, endOffset: 1, startLine: 2, endLine: 4 },
});
const memory = (scope: MemorySearchResultDto['scope']): MemorySearchResultDto => ({
  ...base, kind: 'memory', id: U1, scope, memoryType: 'fact', title: 't', tags: [], status: 'active', confidence: null, source: null,
  provenance: { createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null }, updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('queryTerms', () => {
  it('drops operators, negations and one-letter words and keeps phrases', () => {
    expect(queryTerms('alpha OR "beta gamma" -skip x')).toEqual(['beta gamma', 'alpha']);
  });
});

describe('highlightSegments', () => {
  it('marks case-insensitive matches and keeps all other text', () => {
    expect(highlightSegments('Hello World hello', 'hello')).toEqual([
      { text: 'Hello', match: true },
      { text: ' World ', match: false },
      { text: 'hello', match: true },
    ]);
  });
  it('treats regex metacharacters and markup in the query as literal text', () => {
    expect(highlightSegments('a (b) .* c', '(b) .*').filter((x) => x.match).map((x) => x.text)).toEqual(['(b)', '.*']);
    expect(highlightSegments('x <img src=x onerror=alert(1)> y', '<img')).toEqual([
      { text: 'x ', match: false },
      { text: '<img', match: true },
      { text: ' src=x onerror=alert(1)> y', match: false },
    ]);
  });
  it('returns the text unchanged without usable terms', () => {
    expect(highlightSegments('abc', '-abc')).toEqual([{ text: 'abc', match: false }]);
  });
});

describe('excerpt', () => {
  it('keeps short text and windows long text around the first match', () => {
    expect(excerpt('  a   b ', 'a')).toBe('a b');
    const long = `${'x '.repeat(400)}needle${' y'.repeat(400)}`;
    const e = excerpt(long, 'needle');
    expect(e).toContain('needle');
    expect(e.length).toBeLessThanOrEqual(502);
    expect(e.startsWith('…')).toBe(true);
  });
});

describe('describeLocation', () => {
  it('joins heading path, page and lines', () => {
    expect(describeLocation({ headingPath: ['A', 'B'], page: 2, startOffset: 0, endOffset: 1, startLine: 3, endLine: 3 })).toBe('A › B · page 2 · line 3');
    expect(describeLocation({ startOffset: 0, endOffset: 1, startLine: 1, endLine: 5 })).toBe('lines 1–5');
  });
});

describe('resultHref', () => {
  it('uses the result scope, so a Global result opens the Global detail', () => {
    expect(resultHref(chunk({ kind: 'global' }))).toBe(`/global/files?file=${U1}&chunk=${U2}&ordinal=3`);
    expect(resultHref(chunk({ kind: 'workspace', id: 'w', slug: 'my ws' }))).toBe(`/w/my%20ws/files?file=${U1}&chunk=${U2}&ordinal=3`);
    expect(resultHref(memory({ kind: 'global' }))).toBe(`/global/memories?memory=${U1}`);
    expect(resultHref(memory({ kind: 'workspace', id: 'w', slug: 'a' }))).toBe(`/w/a/memories?memory=${U1}`);
  });
});

describe('focus parsing', () => {
  it('accepts UUIDs and small integers only', () => {
    expect(parseFileFocus({ file: U1, chunk: U2, ordinal: '3' })).toEqual({ fileId: U1, chunkId: U2, ordinal: 3 });
    expect(parseFileFocus({ file: U1, chunk: 'nope', ordinal: '-1' })).toEqual({ fileId: U1, chunkId: null, ordinal: null });
    expect(parseFileFocus({ file: '../x' })).toBeNull();
    expect(parseFileFocus({})).toBeNull();
    expect(parseMemoryFocus({ memory: [U1, U2] })).toBe(U1);
    expect(parseMemoryFocus({ memory: '<script>' })).toBeNull();
  });
});
