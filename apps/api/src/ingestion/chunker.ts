import type { Document } from './document.js';

/**
 * Deterministic chunker. Splits `Document`s into chunks that point back into the ORIGINAL text.
 *
 * Definitions (shared with `Document`):
 * - Offsets are UTF-16 code unit indexes into the original decoded text, half-open `[startOffset, endOffset)`, so
 *   `originalText.slice(startOffset, endOffset) === content` exactly (no trimming, no newline normalization).
 * - Lines are 1-based. A line break is `\n`, `\r\n` (one break) or a lone `\r`. `startLine` is the line of the first
 *   character of the chunk, `endLine` the line of its last character (a trailing line break belongs to the line it
 *   ends), so the range is inclusive.
 * - Chunks that are empty or whitespace only are dropped. Ordinals are 0-based, file-wide and consecutive across all
 *   documents, in input order.
 * - Size splitting uses hard cuts of at most `chunkSizeChars` characters; consecutive chunks of a section share
 *   `chunkOverlapChars` characters, and the start always advances (forward progress). A cut never splits a surrogate
 *   pair, so a chunk may be one character longer or shorter than the size to keep a pair whole.
 * - Markdown documents (extension `md` or `markdown`) are first split into heading sections (ATX headings `#`..`######`
 *   outside fenced code); a chunk never spans two sections. Setext headings are not recognised.
 */
export interface ChunkOptions {
  /** Maximum characters per chunk (positive integer). */
  chunkSizeChars: number;
  /** Characters shared by consecutive chunks of one section (integer >= 0, smaller than the size). */
  chunkOverlapChars: number;
}

export interface Chunk {
  fileId: string;
  /** 0-based, file-wide, consecutive. */
  ordinal: number;
  content: string;
  startOffset: number;
  endOffset: number;
  startLine: number;
  endLine: number;
  /** Heading texts from the outermost to the innermost enclosing heading; empty outside headings and for non-Markdown. */
  headingPath: string[];
  /** `headingPath` joined with ' > ', or null when there is no heading. */
  section: string | null;
  page?: number;
  label?: string;
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown']);
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

interface Section {
  start: number;
  end: number;
  headingPath: string[];
}

export function chunkDocuments(documents: readonly Document[], options: ChunkOptions): Chunk[] {
  const { chunkSizeChars: size, chunkOverlapChars: overlap } = options;
  if (!Number.isInteger(size) || size < 1) throw new RangeError('chunkSizeChars must be a positive integer');
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= size) {
    throw new RangeError('chunkOverlapChars must be an integer of at least 0 and smaller than chunkSizeChars');
  }

  const chunks: Chunk[] = [];
  for (const doc of documents) {
    const text = doc.content;
    if (text.length === 0) continue;
    const breaks = lineBreakIndexes(text);
    const sections: Section[] = MARKDOWN_EXTENSIONS.has(doc.source.extension.toLowerCase())
      ? markdownSections(text)
      : [{ start: 0, end: text.length, headingPath: [] }];

    for (const section of sections) {
      for (const [start, end] of windows(text, section.start, section.end, size, overlap)) {
        const content = text.slice(start, end);
        if (content.trim().length === 0) continue;
        const chunk: Chunk = {
          fileId: doc.source.fileId,
          ordinal: chunks.length,
          content,
          startOffset: doc.startOffset + start,
          endOffset: doc.startOffset + end,
          startLine: doc.startLine + countBelow(breaks, start),
          endLine: doc.startLine + countBelow(breaks, end - 1),
          headingPath: section.headingPath,
          section: section.headingPath.length > 0 ? section.headingPath.join(' > ') : null,
        };
        if (doc.page !== undefined) chunk.page = doc.page;
        if (doc.label !== undefined) chunk.label = doc.label;
        chunks.push(chunk);
      }
    }
  }
  return chunks;
}

/** Windows [start, end) of at most `size` characters over [from, to), stepping by size - overlap. */
function windows(text: string, from: number, to: number, size: number, overlap: number): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  let start = from;
  while (start < to) {
    let end = Math.min(start + size, to);
    if (end < to && isSplitPair(text, end)) {
      end = end - 1 > start ? end - 1 : Math.min(start + 2, to);
    }
    result.push([start, end]);
    if (end >= to) break;
    let next = Math.max(end - overlap, start + 1);
    if (next < to && isSplitPair(text, next)) next += 1;
    start = next;
  }
  return result;
}

/** True when index `i` falls between a high and a low surrogate. */
function isSplitPair(text: string, i: number): boolean {
  const before = text.charCodeAt(i - 1);
  const at = text.charCodeAt(i);
  return before >= 0xd800 && before <= 0xdbff && at >= 0xdc00 && at <= 0xdfff;
}

/** Indexes of the last character of every line break (`\n`, the `\n` of `\r\n`, or a lone `\r`). */
function lineBreakIndexes(text: string): number[] {
  const result: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) result.push(i);
    else if (c === 13 && text.charCodeAt(i + 1) !== 10) result.push(i);
  }
  return result;
}

/** Number of breaks at an index below `offset` (binary search; `breaks` is ascending). */
function countBelow(breaks: number[], offset: number): number {
  let lo = 0;
  let hi = breaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (breaks[mid]! < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function markdownSections(text: string): Section[] {
  const sections: Section[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: Section = { start: 0, end: text.length, headingPath: [] };
  let fence: { char: string; length: number } | null = null;

  let pos = 0;
  while (pos < text.length) {
    let lineEnd = pos;
    while (lineEnd < text.length && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') lineEnd++;
    let next = lineEnd;
    if (text[next] === '\r' && text[next + 1] === '\n') next += 2;
    else if (next < text.length) next += 1;
    const line = text.slice(pos, lineEnd);

    if (fence) {
      const close = FENCE.exec(line);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length && close[2]!.trim() === '') fence = null;
    } else {
      const open = FENCE.exec(line);
      if (open && !(open[1]![0] === '`' && open[2]!.includes('`'))) {
        fence = { char: open[1]![0]!, length: open[1]!.length };
      } else {
        const heading = HEADING.exec(line);
        if (heading) {
          const level = heading[1]!.length;
          const title = (heading[2] ?? '').replace(/[ \t]+#+$/, '').replace(/^#+$/, '').trim();
          while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
          stack.push({ level, title });
          current.end = pos;
          if (current.end > current.start) sections.push(current);
          current = { start: pos, end: text.length, headingPath: stack.map((h) => h.title).filter((t) => t.length > 0) };
        }
      }
    }
    pos = next;
  }
  if (current.end > current.start) sections.push(current);
  return sections;
}
