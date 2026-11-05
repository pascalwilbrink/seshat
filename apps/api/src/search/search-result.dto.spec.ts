import { describe, expect, it } from 'vitest';
import { toChunkSearchResult, toMemorySearchResult, type ChunkResultSource, type MemoryResultSource, type SearchResponse } from './search-result.dto.js';

const ws = { kind: 'workspace', id: '0b3d6f0e-6c2a-4a58-9f0e-3f1a2b3c4d5e', slug: 'gilde' } as const;

const chunkSource = (over: Partial<ChunkResultSource> = {}): ChunkResultSource => ({
  id: 'c1', content: 'text', ordinal: 3, fileId: 'f1', fileName: 'notes.md', collectionId: null, scope: ws,
  score: 1 / 61, vectorRank: 1, keywordRank: null,
  location: { section: 'Intro', headingPath: ['Doc', 'Intro'], startOffset: 0, endOffset: 4, startLine: 1, endLine: 2, page: 2, junk: 'x' },
  ...over,
});

const memorySource = (over: Partial<MemoryResultSource> = {}): MemoryResultSource => ({
  id: 'm1', content: 'remember', scope: { kind: 'global' }, type: 'decision', title: null, tags: ['a'], status: 'active', confidence: 0.5, source: null,
  createdByKind: 'apiKey', createdByKeyId: 'k1', createdByKeyName: 'agent', clientName: null, clientVersion: null,
  updatedAt: '2026-01-02T03:04:05.000Z', score: 2 / 61, vectorRank: 2, keywordRank: 1, ...over,
});

describe('search result contract', () => {
  it('chunk result carries scope with id and slug, file, Collection, ordinal, location and nullable ranks', () => {
    const r = toChunkSearchResult(chunkSource());
    expect(r).toEqual({
      kind: 'chunk', id: 'c1', score: 1 / 61, vectorRank: 1, keywordRank: null, scope: ws, content: 'text',
      file: { id: 'f1', name: 'notes.md' }, collectionId: null, ordinal: 3,
      location: { section: 'Intro', headingPath: ['Doc', 'Intro'], startOffset: 0, endOffset: 4, startLine: 1, endLine: 2, page: 2 },
    });
  });

  it('memory result carries type, title, tags, status, confidence, source, provenance and updated time', () => {
    const r = toMemorySearchResult(memorySource({ clientName: 'cli', clientVersion: '1.0' }));
    expect(r).toEqual({
      kind: 'memory', id: 'm1', score: 2 / 61, vectorRank: 2, keywordRank: 1, scope: { kind: 'global' }, content: 'remember',
      memoryType: 'decision', title: null, tags: ['a'], status: 'active', confidence: 0.5, source: null,
      provenance: { createdBy: { kind: 'apiKey', keyId: 'k1', keyName: 'agent' }, client: { name: 'cli', version: '1.0' } },
      updatedAt: '2026-01-02T03:04:05.000Z',
    });
  });

  it('keyword-only items have a null vector rank and are still valid', () => {
    expect(toMemorySearchResult(memorySource({ vectorRank: null })).vectorRank).toBeNull();
  });

  it('never copies fields outside the allowlist (vectors, storage keys, secrets, hashes)', () => {
    const polluted = {
      ...chunkSource(), embedding: [0.1], storageKey: 'originals/x', keyHash: 'h', secret: 's', contentHash: 'c', total: 5,
    } as ChunkResultSource;
    const mem = { ...memorySource(), embedding: [0.1], contentHash: 'h', apiKey: 'sk_seshat_x', excluded: 3 } as MemoryResultSource;
    const json = JSON.stringify([toChunkSearchResult(polluted), toMemorySearchResult(mem)]);
    for (const banned of ['embedding', 'storageKey', 'originals/', 'keyHash', 'secret', 'contentHash', 'sk_seshat', 'total', 'excluded']) {
      expect(json).not.toContain(banned);
    }
  });

  it('the response shape has results and an optional degraded marker, no totals or counts', () => {
    const full: SearchResponse = { results: [], degraded: 'keyword_only' };
    expect(Object.keys(full).sort()).toEqual(['degraded', 'results']);
    const plain: SearchResponse = { results: [] };
    expect(Object.keys(plain)).toEqual(['results']);
  });
});
