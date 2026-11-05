import { Inject, Injectable } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { EMBEDDING_SERVICE, type EmbeddingService, validateEmbeddings } from '../ingestion/embedding.service.js';
import { fuseRankings, type Ranking } from './rrf.js';
import {
  type AnnSettings,
  type AnnStrategy,
  RetrievalRepository,
  annSettingsFor,
  queryScopeOf,
} from './retrieval.repository.js';
import type { AuthorizedSearchPlan } from './search-plan.js';
import { type SearchRequest, splitSearchFilters } from './search-request.dto.js';
import { type SearchResponse, type SearchResult, toChunkSearchResult, toMemorySearchResult } from './search-result.dto.js';

/** Candidates fetched per ranking: enough that fusion, `minScore` and the final cut still fill `limit`. */
export const CANDIDATE_FACTOR = 4;
export const CANDIDATE_MAX = 200;
export const candidateCount = (limit: number): number => Math.min(CANDIDATE_MAX, Math.max(1, limit) * CANDIDATE_FACTOR);

/**
 * Internal diagnostics of one retrieval. Contains no content, ids or counts of excluded items, and is never part
 * of a response; tests and operations use it to see which ANN strategy ran.
 */
export interface RetrievalTrace {
  embeddingCalls: number;
  degraded: boolean;
  annStrategy: AnnStrategy | null;
  /** Vector branches whose index scan returned fewer rows than wanted and were re-run as scoped exact scans. */
  exactFallbacks: number;
}

/**
 * Hybrid retrieval over chunks of indexed files and Memories. It takes an `AuthorizedSearchPlan` (the only source of
 * scopes and readable types) and a validated request; it performs no authorization of its own and must only be called
 * after `AuthorizationService.authorizeSearch`.
 *
 * Verified pgvector strategy (see retrieval.repository.ts): the installed `vector` extension version is read from
 * `pg_extension`. From 0.8.0, HNSW scans are iterative (`hnsw.iterative_scan = strict_order`, raised
 * `hnsw.max_scan_tuples`); older versions get `hnsw.ef_search = 1000` only. In both cases a vector branch that returns
 * fewer rows than wanted is re-run as a scoped exact scan, so selective filters fill `limit` whenever enough rows
 * qualify. All settings are transaction-local (`set_config(..., true)`).
 */
@Injectable()
export class RetrievalService {
  private readonly repo = new RetrievalRepository();
  private extVersion: Promise<string | null> | undefined;

  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(EMBEDDING_SERVICE) private readonly embeddings: EmbeddingService,
  ) {}

  async retrieve(plan: AuthorizedSearchPlan, request: SearchRequest): Promise<SearchResponse> {
    return (await this.retrieveWithTrace(plan, request)).response;
  }

  async retrieveWithTrace(plan: AuthorizedSearchPlan, request: SearchRequest): Promise<{ response: SearchResponse; trace: RetrievalTrace }> {
    const trace: RetrievalTrace = { embeddingCalls: 0, degraded: false, annStrategy: null, exactFallbacks: 0 };
    const types = plan.types.filter((t) => request.types.includes(t));
    if (types.length === 0 || plan.scopes.length === 0) return { response: { results: [] }, trace };

    // The query is embedded exactly once and the vector is reused by every vector branch. Only a failure of the
    // provider call is caught; database and authorization failures are never masked.
    const vector = await this.embedQuery(request.query, trace);

    const scope = queryScopeOf(plan.scopes);
    const filters = splitSearchFilters(request);
    const wanted = candidateCount(request.limit);

    const response = await this.dataSource.transaction(async (m) => {
      let settings: AnnSettings | null = null;
      if (vector) {
        settings = annSettingsFor(await this.vectorVersion(m), wanted);
        trace.annStrategy = settings.strategy;
        await this.repo.applyAnnSettings(m, settings);
      }

      const rankings: Ranking[] = [];
      for (const type of types) {
        const kind = type === 'files' ? 'chunk' : 'memory';
        const rank = (branch: 'vector' | 'keyword', exact = false): Promise<string[]> =>
          type === 'files'
            ? this.repo.rankChunks(m, branch, { scope, filters: filters.chunk, limit: wanted, ...(vector ? { vector } : {}), queryText: request.query, exact })
            : this.repo.rankMemories(m, branch, { scope, filters: filters.memory, limit: wanted, ...(vector ? { vector } : {}), queryText: request.query, exact });
        if (vector) {
          let ids = await rank('vector');
          if (ids.length < wanted) {
            // The index scan underfilled (filter more selective than the scan could see past): scoped exact scan.
            trace.exactFallbacks += 1;
            ids = await rank('vector', true);
          }
          rankings.push({ kind, source: 'vector', ids });
        }
        rankings.push({ kind, source: 'keyword', ids: await rank('keyword') });
      }

      const fused = fuseRankings(rankings, { limit: request.limit, minScore: request.minScore });
      const chunkIds = fused.filter((f) => f.kind === 'chunk').map((f) => f.id);
      const memoryIds = fused.filter((f) => f.kind === 'memory').map((f) => f.id);
      const [chunks, memories] = await Promise.all([
        this.repo.loadChunks(m, scope, chunkIds),
        this.repo.loadMemories(m, scope, memoryIds, request.includeSuperseded),
      ]);
      const results: SearchResult[] = [];
      for (const f of fused) {
        const ranks = { score: f.score, vectorRank: f.vectorRank, keywordRank: f.keywordRank };
        if (f.kind === 'chunk') {
          const row = chunks.get(f.id);
          if (row) results.push(toChunkSearchResult({ ...row, ...ranks }));
        } else {
          const row = memories.get(f.id);
          if (row) results.push(toMemorySearchResult({ ...row, ...ranks }));
        }
      }
      return results;
    });

    return { response: trace.degraded ? { results: response, degraded: 'keyword_only' } : { results: response }, trace };
  }

  private async embedQuery(query: string, trace: RetrievalTrace): Promise<number[] | null> {
    trace.embeddingCalls += 1;
    try {
      const [vector] = validateEmbeddings(await this.embeddings.embed([query]), 1, this.embeddings.dimension);
      return vector ?? null;
    } catch {
      // Deterministic degradation; the provider's error text is never kept, logged or returned.
      trace.degraded = true;
      return null;
    }
  }

  private vectorVersion(m: EntityManager): Promise<string | null> {
    this.extVersion ??= this.repo.vectorExtensionVersion(m).catch((err) => {
      this.extVersion = undefined;
      throw err;
    });
    return this.extVersion;
  }
}
