import { describe, expect, it } from 'vitest';
import { MCP_TOOL_CATALOG } from '@seshat/domain';
import { SUMMARIZED_TOOLS, summarizeArgs } from './mcp-args-summary.js';

const S = 'SENTINEL-args-9f3b';
const ID = '0b0e7a30-1c1f-4f6e-9a55-3a5f3b0c7d11';

describe('summarizeArgs', () => {
  it('has an allowlist entry for every catalog tool', () => {
    expect([...SUMMARIZED_TOOLS].sort()).toEqual(Object.keys(MCP_TOOL_CATALOG).sort());
  });

  it('drops queries, content, titles, metadata, tags, cursors and unknown fields from every tool', () => {
    const hostile = {
      query: S, text: S, base64: S, content: S, title: S, metadata: { a: S }, tag: S, name: S, cursor: S, tags: [S, S],
      context: S, source: S, extra: S, __proto__: { x: S },
    };
    for (const tool of Object.keys(MCP_TOOL_CATALOG)) {
      // The upload file name is the one permitted free-text field (spec), covered separately below.
      const input = tool === 'upload_file' ? { ...hostile, name: undefined } : hostile;
      const out = JSON.stringify(summarizeArgs(tool, input));
      expect(out, tool).not.toContain(S);
    }
  });

  it('keeps typed safe fields of a search and rejects wrong types', () => {
    expect(
      summarizeArgs('search_knowledge', {
        query: S, types: ['files', S], includeGlobal: true, collectionIds: [ID, S], tagMatch: 'all', limit: 5, minScore: 0.2, tags: [S],
      }),
    ).toEqual({ types: ['files'], includeGlobal: true, collectionIds: [ID], tagMatch: 'all', limit: 5, minScore: 0.2 });
    expect(summarizeArgs('list_files', { scope: S, status: S, limit: S, collectionId: S })).toEqual({});
  });

  it('summarizes uploads by base name, size and tag count only', () => {
    expect(summarizeArgs('upload_file', { name: '/x/y/notes.md', text: `héllo ${S}`, tags: [S, S, S] })).toEqual({
      fileName: 'notes.md', sizeBytes: Buffer.byteLength(`héllo ${S}`), encoding: 'text', tagCount: 3,
    });
    const out = summarizeArgs('upload_file', { name: 'a.bin', base64: 'QUJD' });
    expect(out).toEqual({ fileName: 'a.bin', sizeBytes: 3, encoding: 'base64' });
  });

  it('gives {} for unknown tools and non-object arguments', () => {
    expect(summarizeArgs('nope', { limit: 3 })).toEqual({});
    expect(summarizeArgs('list_files', 'x')).toEqual({});
    expect(summarizeArgs('list_files', [1])).toEqual({});
  });
});
