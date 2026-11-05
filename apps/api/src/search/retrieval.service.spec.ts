import { describe, expect, it, vi } from 'vitest';
import { FakeEmbeddingService } from '../ingestion/fake-embedding.service.js';
import { annSettingsFor, supportsIterativeScan, toVectorLiteral } from './retrieval.repository.js';
import { RetrievalService, candidateCount } from './retrieval.service.js';
import type { SearchRequest } from './search-request.dto.js';

const WS = '11111111-1111-4111-8111-111111111111';
const request = (over: Partial<SearchRequest> = {}): SearchRequest => ({
  query: 'x',
  types: ['files', 'memories'],
  tagMatch: 'any',
  includeSuperseded: false,
  limit: 10,
  includeGlobal: false,
  ...over,
});
const plan = { scopes: [{ kind: 'workspace' as const, workspaceId: WS }], types: ['files', 'memories'] as ('files' | 'memories')[] };

function harness(embeddings: { embed(t: string[]): Promise<number[][]>; dimension: number; model: string }) {
  const log: { sql: string; params: unknown[] }[] = [];
  const manager = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      log.push({ sql, params });
      return /pg_extension/.test(sql) ? [{ extversion: '0.6.0' }] : [];
    }),
  };
  const ds = { transaction: async (fn: (m: unknown) => unknown) => fn(manager) };
  return { service: new RetrievalService(ds as never, embeddings as never), log };
}

describe('retrieval pgvector strategy', () => {
  it('uses iterative scans only from pgvector 0.8.0, never assuming support', () => {
    for (const v of ['0.8.0', '0.8.1', '0.10.0', '1.0.0']) expect(supportsIterativeScan(v)).toBe(true);
    for (const v of ['0.7.4', '0.6.0', '0.5.1', null, '', 'garbage']) expect(supportsIterativeScan(v)).toBe(false);
    expect(annSettingsFor('0.8.0', 40).strategy).toBe('iterative_scan');
    expect(annSettingsFor('0.7.4', 40)).toMatchObject({ strategy: 'ef_search_then_exact', efSearch: 1000 });
  });

  it('wants at least 4 x limit candidates, bounded', () => {
    expect(candidateCount(10)).toBe(40);
    expect(candidateCount(1)).toBe(4);
    expect(candidateCount(50)).toBe(200);
  });
});

describe('retrieval SQL safety', () => {
  it('serializes only finite vectors', () => {
    expect(toVectorLiteral([1, 0.5, -2e-7])).toBe('[1,0.5,-2e-7]');
    expect(() => toVectorLiteral([1, Number.NaN])).toThrow();
    expect(() => toVectorLiteral([Infinity])).toThrow();
    expect(() => toVectorLiteral(['1);DROP' as unknown as number])).toThrow();
  });

  it('binds the query, vector and ids as parameters and never interpolates them into SQL text', async () => {
    const fake = new FakeEmbeddingService(1536);
    const { service, log } = harness(fake);
    const hostile = `'; DROP TABLE chunks; -- ${WS}`;
    const id = '22222222-2222-4222-8222-222222222222';
    await service.retrieve(plan, request({ query: hostile, fileIds: [id], collectionIds: [id], tags: ['a'], memoryTypes: ['fact'] }));
    expect(log.length).toBeGreaterThan(4);
    for (const { sql } of log) {
      expect(sql).not.toContain('DROP TABLE');
      expect(sql).not.toContain(id);
      expect(sql).not.toContain(WS);
      expect(sql).not.toMatch(/\[-?\d/);
    }
    const allParams = log.flatMap((l) => l.params);
    expect(allParams).toContain(hostile);
    expect(allParams.some((p) => typeof p === 'string' && p.startsWith('[') && p.length > 1000)).toBe(true);
    expect(fake.calls).toEqual([[hostile]]);
  });

  it('embeds once for both types and every branch', async () => {
    const fake = new FakeEmbeddingService(1536);
    const { service } = harness(fake);
    await service.retrieve(plan, request());
    expect(fake.calls).toHaveLength(1);
  });

  it('does not embed or query when nothing is readable', async () => {
    const fake = new FakeEmbeddingService(1536);
    const { service, log } = harness(fake);
    expect(await service.retrieve({ scopes: plan.scopes, types: [] }, request())).toEqual({ results: [] });
    expect(fake.calls).toEqual([]);
    expect(log).toEqual([]);
  });

  it('falls back to keyword-only on provider failure without keeping the provider text', async () => {
    const secret = 'sk-provider-secret-text';
    const embeddings = { dimension: 1536, model: 'm', embed: async () => Promise.reject(new Error(secret)) };
    const { service, log } = harness(embeddings);
    const { response, trace } = await service.retrieveWithTrace(plan, request());
    expect(response).toEqual({ results: [], degraded: 'keyword_only' });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(trace).toMatchObject({ degraded: true, embeddingCalls: 1, annStrategy: null });
    expect(log.some((l) => /<=>/.test(l.sql))).toBe(false);
    expect(log.some((l) => /websearch_to_tsquery/.test(l.sql))).toBe(true);
  });

  it('treats malformed provider output as a provider failure', async () => {
    const embeddings = { dimension: 1536, model: 'm', embed: async () => [[1, 2, 3]] };
    const { service } = harness(embeddings);
    expect((await service.retrieve(plan, request())).degraded).toBe('keyword_only');
  });

  it('does not mask database failures', async () => {
    const fake = new FakeEmbeddingService(1536);
    const service = new RetrievalService(
      { transaction: async () => Promise.reject(new Error('db down')) } as never,
      fake as never,
    );
    await expect(service.retrieve(plan, request())).rejects.toThrow('db down');
  });
});
