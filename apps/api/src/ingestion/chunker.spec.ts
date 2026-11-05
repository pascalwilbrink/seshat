import { describe, expect, it } from 'vitest';
import { chunkDocuments, type Chunk } from './chunker.js';
import type { Document } from './document.js';

function doc(content: string, extension = 'txt', extra: Partial<Document> = {}): Document {
  return { content, source: { fileId: 'file-1', fileName: `f.${extension}`, extension }, startOffset: 0, startLine: 1, ...extra };
}
const opts = (chunkSizeChars: number, chunkOverlapChars = 0) => ({ chunkSizeChars, chunkOverlapChars });
/** Every chunk must be an exact slice of the original text. */
function expectSlices(text: string, chunks: Chunk[], base = 0) {
  for (const c of chunks) expect(text.slice(c.startOffset - base, c.endOffset - base)).toBe(c.content);
}

describe('chunkDocuments', () => {
  it('rejects invalid options', () => {
    expect(() => chunkDocuments([], opts(0))).toThrow(RangeError);
    expect(() => chunkDocuments([], opts(5, 5))).toThrow(RangeError);
    expect(() => chunkDocuments([], opts(5, -1))).toThrow(RangeError);
  });

  it('honors size and overlap with half-open offsets', () => {
    const text = 'abcdefghij';
    const chunks = chunkDocuments([doc(text)], opts(4, 1));
    expect(chunks.map((c) => [c.content, c.startOffset, c.endOffset])).toEqual([
      ['abcd', 0, 4],
      ['defg', 3, 7],
      ['ghij', 6, 10],
    ]);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1, 2]);
    expect(chunks[0]!.fileId).toBe('file-1');
  });

  it('makes a single chunk when the text fits, and none for blank documents', () => {
    expect(chunkDocuments([doc('hello')], opts(5, 2))).toHaveLength(1);
    expect(chunkDocuments([doc('')], opts(5))).toEqual([]);
    expect(chunkDocuments([doc('  \n\t \r\n ')], opts(3))).toEqual([]);
  });

  it('drops whitespace-only windows but keeps the offsets of the rest', () => {
    const text = 'ab      cd';
    const chunks = chunkDocuments([doc(text)], opts(2));
    expect(chunks.map((c) => c.content)).toEqual(['ab', 'cd']);
    expect(chunks.map((c) => c.ordinal)).toEqual([0, 1]);
    expectSlices(text, chunks);
  });

  it('makes progress with the maximum overlap and with size 1', () => {
    expect(chunkDocuments([doc('abcde')], opts(2, 1)).map((c) => c.content)).toEqual(['ab', 'bc', 'cd', 'de']);
    expect(chunkDocuments([doc('abc')], opts(1)).map((c) => c.content)).toEqual(['a', 'b', 'c']);
  });

  it('splits very long lines', () => {
    const text = 'x'.repeat(10_000);
    const chunks = chunkDocuments([doc(text)], opts(2000, 200));
    expect(chunks.every((c) => c.content.length <= 2000)).toBe(true);
    expect(chunks.every((c) => c.startLine === 1 && c.endLine === 1)).toBe(true);
    expect(chunks.at(-1)!.endOffset).toBe(10_000);
    expectSlices(text, chunks);
  });

  it('is deterministic', () => {
    const d = [doc('# A\ntext '.repeat(50), 'md')];
    expect(chunkDocuments(d, opts(30, 5))).toEqual(chunkDocuments(d, opts(30, 5)));
  });

  it('computes line ranges for LF, CRLF and lone CR', () => {
    const text = 'l1\r\nl2\r\nl3\nl4\rl5';
    const chunks = chunkDocuments([doc(text)], opts(100));
    expect([chunks[0]!.startLine, chunks[0]!.endLine]).toEqual([1, 5]);
    const parts = chunkDocuments([doc(text)], opts(4));
    expectSlices(text, parts);
    // "l1\r" ends on line 1; "\nl2" starts on line 1 (the \n ends line 1) and ends on line 2.
    expect(parts[0]).toMatchObject({ content: 'l1\r\n', startLine: 1, endLine: 1 });
    expect(parts[1]).toMatchObject({ content: 'l2\r\n', startLine: 2, endLine: 2 });
    expect(parts[2]).toMatchObject({ content: 'l3\nl', startLine: 3, endLine: 4 });
  });

  it('keeps a CRLF split across chunks on one line', () => {
    const text = 'ab\r\ncd';
    const parts = chunkDocuments([doc(text)], opts(3));
    expect(parts[0]).toMatchObject({ content: 'ab\r', startLine: 1, endLine: 1 });
    expect(parts[1]).toMatchObject({ content: '\ncd', startLine: 1, endLine: 2 });
  });

  it('uses UTF-16 offsets and never splits surrogate pairs', () => {
    const text = 'a😀b😀c€é';
    const chunks = chunkDocuments([doc(text)], opts(2));
    expectSlices(text, chunks);
    for (const c of chunks) expect(c.content).not.toMatch(/^[\udc00-\udfff]|[\ud800-\udbff]$/);
    expect(chunks.map((c) => c.content).join('')).toBe(text);
    const one = chunkDocuments([doc('😀😀')], opts(1));
    expect(one.map((c) => c.content)).toEqual(['😀', '😀']);
  });

  it('keeps BOM and original offsets with Document start offset and line', () => {
    const text = '﻿hello\nworld';
    const chunks = chunkDocuments([doc(text, 'txt', { startOffset: 100, startLine: 10 })], opts(7));
    expect(chunks[0]).toMatchObject({ startOffset: 100, startLine: 10 });
    expect(chunks[1]).toMatchObject({ startOffset: 107, startLine: 11 });
    expectSlices(text, chunks, 100);
  });

  it('numbers ordinals across multiple documents and keeps page metadata', () => {
    const a = doc('aaaa', 'txt', { page: 1 });
    const b = doc('   ', 'txt', { page: 2 });
    const c = doc('bbbb', 'txt', { page: 3, label: 'Sheet', startOffset: 4, startLine: 2 });
    const chunks = chunkDocuments([a, b, c], opts(2));
    expect(chunks.map((x) => [x.ordinal, x.content, x.page])).toEqual([
      [0, 'aa', 1],
      [1, 'aa', 1],
      [2, 'bb', 3],
      [3, 'bb', 3],
    ]);
    expect(chunks[2]).toMatchObject({ label: 'Sheet', startOffset: 4, startLine: 2 });
    expect(chunks[0]!.label).toBeUndefined();
  });

  describe('Markdown', () => {
    it('splits on headings, records nested paths and stays within sections', () => {
      const text = 'intro\n# A\na body\n## B\nb body\n# C\nc body\n';
      const chunks = chunkDocuments([doc(text, 'md')], opts(1000));
      expect(chunks.map((c) => [c.section, c.content])).toEqual([
        [null, 'intro\n'],
        ['A', '# A\na body\n'],
        ['A > B', '## B\nb body\n'],
        ['C', '# C\nc body\n'],
      ]);
      expect(chunks[2]!.headingPath).toEqual(['A', 'B']);
      expect([chunks[1]!.startLine, chunks[1]!.endLine]).toEqual([2, 3]);
      expectSlices(text, chunks);
    });

    it('handles skipped levels, closing hashes and empty headings', () => {
      const text = '# A\n### C ###\nx\n## B\ny\n#\nz\n';
      const chunks = chunkDocuments([doc(text, 'md')], opts(1000));
      expect(chunks.map((c) => c.headingPath)).toEqual([['A'], ['A', 'C'], ['A', 'B'], []]);
    });

    it('does not treat fenced code contents as headings', () => {
      const text = '# Real\n```sh\n# not a heading\n```\n~~~\n## nor this\n~~~\ntext\n';
      const chunks = chunkDocuments([doc(text, 'md')], opts(1000));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.headingPath).toEqual(['Real']);
      // A longer fence is only closed by an equally long one.
      const nested = '````\n```\n# x\n````\n# After\n';
      expect(chunkDocuments([doc(nested, 'md')], opts(1000)).map((c) => c.section)).toEqual([null, 'After']);
    });

    it('ignores indented code and hashes without a space', () => {
      const chunks = chunkDocuments([doc('    # code\n#nospace\n', 'md')], opts(1000));
      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.section).toBeNull();
    });

    it('splits sections that exceed the size without crossing headings', () => {
      const text = `# A\n${'a'.repeat(20)}\n# B\n${'b'.repeat(10)}\n`;
      const chunks = chunkDocuments([doc(text, 'md')], opts(10, 2));
      expectSlices(text, chunks);
      const a = chunks.filter((c) => c.section === 'A');
      const b = chunks.filter((c) => c.section === 'B');
      expect(a.length).toBeGreaterThan(2);
      expect(a.at(-1)!.endOffset).toBe(text.indexOf('# B'));
      expect(b[0]!.startOffset).toBe(text.indexOf('# B'));
      expect(chunks.map((c) => c.ordinal)).toEqual(chunks.map((_, i) => i));
    });

    it('handles CRLF Markdown and an uppercase extension', () => {
      const text = '# A\r\nx\r\n## B\r\ny\r\n';
      const chunks = chunkDocuments([doc(text, 'MD')], opts(1000));
      expect(chunks.map((c) => [c.section, c.startLine, c.endLine])).toEqual([
        ['A', 1, 2],
        ['A > B', 3, 4],
      ]);
      expectSlices(text, chunks);
    });

    it('does not parse headings in plain text', () => {
      expect(chunkDocuments([doc('# A\nx')], opts(100))[0]!.section).toBeNull();
    });
  });
});
