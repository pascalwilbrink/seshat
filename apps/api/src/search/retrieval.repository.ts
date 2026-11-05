import type { EntityManager } from 'typeorm';
import type { ScopeRef } from '../scopes/scope-ref.js';
import { scopeKeyOf } from '../tags/tags.service.js';
import type { ChunkFilters, MemoryFilters } from './search-request.dto.js';
import type { ChunkResultSource, MemoryResultSource, SearchResultScope } from './search-result.dto.js';

/** How the vector branches fill `limit` under filters. Recorded for operations and tests; never part of a response. */
export type AnnStrategy = 'iterative_scan' | 'ef_search_then_exact';

export interface AnnSettings {
  strategy: AnnStrategy;
  efSearch: number;
  /** Only meaningful for `iterative_scan`. */
  maxScanTuples: number;
}

/**
 * pgvector added `hnsw.iterative_scan` in 0.8.0. Older versions have no such setting (a `SET` of an unknown dotted name
 * would be silently ignored), so support is decided from the installed extension version, never assumed.
 */
export function supportsIterativeScan(extVersion: string | null): boolean {
  const match = /^(\d+)\.(\d+)/.exec(extVersion ?? '');
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 0 || minor >= 8;
}

export const EF_SEARCH_MAX = 1000;
export const ITERATIVE_MAX_SCAN_TUPLES = 100_000;

export function annSettingsFor(extVersion: string | null, wanted: number): AnnSettings {
  return supportsIterativeScan(extVersion)
    ? { strategy: 'iterative_scan', efSearch: Math.min(EF_SEARCH_MAX, Math.max(200, wanted)), maxScanTuples: ITERATIVE_MAX_SCAN_TUPLES }
    : { strategy: 'ef_search_then_exact', efSearch: EF_SEARCH_MAX, maxScanTuples: 0 };
}

/** pgvector text literal for a validated vector; always passed as a bound parameter, never interpolated into SQL. */
export function toVectorLiteral(vector: readonly number[]): string {
  for (const x of vector) if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError('Vector must contain only finite numbers');
  return `[${vector.join(',')}]`;
}

/** Collects bound parameters; the SQL text only ever contains `$n` placeholders. */
class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

export interface QueryScope {
  /** `scope_key`s of the authorized scopes (`global` or a Workspace id). */
  scopeKeys: string[];
}

export const queryScopeOf = (scopes: readonly ScopeRef[]): QueryScope => ({ scopeKeys: scopes.map(scopeKeyOf) });

type Branch = 'vector' | 'keyword';

/**
 * The retrieval SQL. Every branch (chunks/memories x vector/keyword) puts scope, readability and metadata predicates in
 * its WHERE clause, so excluded rows never take part in ordering or LIMIT. Filter ids are only compared against
 * rows already inside the authorized scope: an inaccessible id matches nothing and is never looked up.
 */
export class RetrievalRepository {
  private static chunkWhere(p: Params, scope: QueryScope, filters: ChunkFilters): string {
    const where = [`c."scope_key" = ANY(${p.add(scope.scopeKeys)}::text[])`, `f."ingestion_status" = 'indexed'`];
    if (filters.collectionIds) where.push(`f."collection_id" = ANY(${p.add(filters.collectionIds)}::uuid[])`);
    if (filters.fileIds) where.push(`f."id" = ANY(${p.add(filters.fileIds)}::uuid[])`);
    if (filters.tags) where.push(RetrievalRepository.tagPredicate(p, 'file_tags', 'file_id', 'f', filters.tags, filters.tagMatch));
    return where.join(' AND ');
  }

  private static memoryWhere(p: Params, scope: QueryScope, filters: MemoryFilters, branch: Branch): string {
    const where = [`m."scope_key" = ANY(${p.add(scope.scopeKeys)}::text[])`];
    if (!filters.includeSuperseded) where.push(`m."status" = 'active'`);
    if (filters.types) where.push(`m."type" = ANY(${p.add(filters.types)}::text[])`);
    if (filters.tags) where.push(RetrievalRepository.tagPredicate(p, 'memory_tags', 'memory_id', 'm', filters.tags, filters.tagMatch));
    if (branch === 'vector') where.push(`m."embedding" IS NOT NULL`);
    return where.join(' AND ');
  }

  /** EXISTS / count over the join table, scope-keyed on both composite FKs: no row multiplication in the outer query. */
  private static tagPredicate(p: Params, joinTable: string, ownerColumn: string, alias: string, tags: readonly string[], match: 'any' | 'all'): string {
    const names = p.add(tags);
    const inner = `FROM "${joinTable}" jt JOIN "tags" t ON t."id" = jt."tag_id" AND t."scope_key" = jt."scope_key"
       WHERE jt."${ownerColumn}" = ${alias}."id" AND jt."scope_key" = ${alias}."scope_key" AND t."name" = ANY(${names}::text[])`;
    return match === 'any'
      ? `EXISTS (SELECT 1 ${inner})`
      : `(SELECT count(DISTINCT t."name") ${inner}) = cardinality(${names}::text[])`;
  }

  /** ids of chunks in rank order for one branch. `exact` forces a scoped exact scan (no HNSW). */
  async rankChunks(
    m: EntityManager,
    branch: Branch,
    input: { scope: QueryScope; filters: ChunkFilters; limit: number; vector?: readonly number[]; queryText?: string; exact?: boolean },
  ): Promise<string[]> {
    const p = new Params();
    const from = `FROM "chunks" c JOIN "files" f ON f."id" = c."file_id" AND f."scope_key" = c."scope_key"`;
    let sql: string;
    if (branch === 'vector') {
      const v = p.add(toVectorLiteral(input.vector ?? []));
      const where = RetrievalRepository.chunkWhere(p, input.scope, input.filters);
      // `+ 0` makes the ordering expression unusable by the HNSW index: an exact, scope-filtered scan.
      const dist = input.exact ? `(c."embedding" <=> ${v}::vector) + 0` : `c."embedding" <=> ${v}::vector`;
      sql = `SELECT c."id" AS id ${from} WHERE ${where} ORDER BY ${dist} ASC, c."id" ASC LIMIT ${p.add(input.limit)}`;
    } else {
      const q = p.add(input.queryText ?? '');
      const where = RetrievalRepository.chunkWhere(p, input.scope, input.filters);
      sql = `SELECT c."id" AS id ${from}, websearch_to_tsquery('simple', ${q}) q
             WHERE ${where} AND c."content_tsv" @@ q
             ORDER BY ts_rank(c."content_tsv", q) DESC, c."id" ASC LIMIT ${p.add(input.limit)}`;
    }
    return ((await m.query(sql, p.values)) as { id: string }[]).map((r) => r.id);
  }

  async rankMemories(
    m: EntityManager,
    branch: Branch,
    input: { scope: QueryScope; filters: MemoryFilters; limit: number; vector?: readonly number[]; queryText?: string; exact?: boolean },
  ): Promise<string[]> {
    const p = new Params();
    let sql: string;
    if (branch === 'vector') {
      const v = p.add(toVectorLiteral(input.vector ?? []));
      const where = RetrievalRepository.memoryWhere(p, input.scope, input.filters, 'vector');
      const dist = input.exact ? `(m."embedding" <=> ${v}::vector) + 0` : `m."embedding" <=> ${v}::vector`;
      sql = `SELECT m."id" AS id FROM "memories" m WHERE ${where} ORDER BY ${dist} ASC, m."id" ASC LIMIT ${p.add(input.limit)}`;
    } else {
      const q = p.add(input.queryText ?? '');
      const where = RetrievalRepository.memoryWhere(p, input.scope, input.filters, 'keyword');
      sql = `SELECT m."id" AS id FROM "memories" m, websearch_to_tsquery('simple', ${q}) q
             WHERE ${where} AND m."search_tsv" @@ q
             ORDER BY ts_rank(m."search_tsv", q) DESC, m."id" ASC LIMIT ${p.add(input.limit)}`;
    }
    return ((await m.query(sql, p.values)) as { id: string }[]).map((r) => r.id);
  }

  /** Loads display fields of the final, already-fused chunk ids; scope and indexed state are enforced again. */
  async loadChunks(m: EntityManager, scope: QueryScope, ids: readonly string[]): Promise<Map<string, Omit<ChunkResultSource, 'score' | 'vectorRank' | 'keywordRank'>>> {
    const out = new Map<string, Omit<ChunkResultSource, 'score' | 'vectorRank' | 'keywordRank'>>();
    if (ids.length === 0) return out;
    const rows = (await m.query(
      `SELECT c."id", c."content", c."ordinal", c."location", c."file_id", f."name" AS file_name, f."collection_id",
              c."workspace_id", w."slug" AS workspace_slug
         FROM "chunks" c JOIN "files" f ON f."id" = c."file_id" AND f."scope_key" = c."scope_key"
         LEFT JOIN "workspaces" w ON w."id" = c."workspace_id"
        WHERE c."id" = ANY($1::uuid[]) AND c."scope_key" = ANY($2::text[]) AND f."ingestion_status" = 'indexed'`,
      [ids, scope.scopeKeys],
    )) as Record<string, any>[];
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        content: r.content,
        ordinal: r.ordinal,
        location: r.location,
        fileId: r.file_id,
        fileName: r.file_name,
        collectionId: r.collection_id,
        scope: scopeOfRow(r.workspace_id, r.workspace_slug),
      });
    }
    return out;
  }

  async loadMemories(
    m: EntityManager,
    scope: QueryScope,
    ids: readonly string[],
    includeSuperseded: boolean,
  ): Promise<Map<string, Omit<MemoryResultSource, 'score' | 'vectorRank' | 'keywordRank'>>> {
    const out = new Map<string, Omit<MemoryResultSource, 'score' | 'vectorRank' | 'keywordRank'>>();
    if (ids.length === 0) return out;
    const rows = (await m.query(
      `SELECT m."id", m."content", m."type", m."title", m."status", m."confidence", m."source", m."updated_at",
              m."created_by_kind", m."created_by_key_id", m."created_by_key_name", m."client_name", m."client_version",
              m."workspace_id", w."slug" AS workspace_slug,
              ARRAY(SELECT t."name" FROM "memory_tags" mt JOIN "tags" t ON t."id" = mt."tag_id" AND t."scope_key" = mt."scope_key"
                     WHERE mt."memory_id" = m."id" AND mt."scope_key" = m."scope_key" ORDER BY t."name") AS tags
         FROM "memories" m LEFT JOIN "workspaces" w ON w."id" = m."workspace_id"
        WHERE m."id" = ANY($1::uuid[]) AND m."scope_key" = ANY($2::text[]) AND ($3::boolean OR m."status" = 'active')`,
      [ids, scope.scopeKeys, includeSuperseded],
    )) as Record<string, any>[];
    for (const r of rows) {
      out.set(r.id, {
        id: r.id,
        content: r.content,
        scope: scopeOfRow(r.workspace_id, r.workspace_slug),
        type: r.type,
        title: r.title,
        tags: r.tags ?? [],
        status: r.status,
        confidence: r.confidence,
        source: r.source,
        createdByKind: r.created_by_kind,
        createdByKeyId: r.created_by_key_id,
        createdByKeyName: r.created_by_key_name,
        clientName: r.client_name,
        clientVersion: r.client_version,
        updatedAt: r.updated_at,
      });
    }
    return out;
  }

  /** Installed pgvector version (`pg_extension`), or null when it cannot be determined. */
  async vectorExtensionVersion(m: EntityManager): Promise<string | null> {
    const rows = (await m.query(`SELECT "extversion" FROM "pg_extension" WHERE "extname" = 'vector'`)) as { extversion: string }[];
    return rows[0]?.extversion ?? null;
  }

  /** Transaction-local (`set_config(..., true)`): reverts at COMMIT/ROLLBACK and never reaches the pooled connection. */
  async applyAnnSettings(m: EntityManager, settings: AnnSettings): Promise<void> {
    await m.query(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(settings.efSearch)]);
    if (settings.strategy === 'iterative_scan') {
      await m.query(`SELECT set_config('hnsw.iterative_scan', 'strict_order', true)`);
      await m.query(`SELECT set_config('hnsw.max_scan_tuples', $1, true)`, [String(settings.maxScanTuples)]);
    }
  }
}

function scopeOfRow(workspaceId: string | null, slug: string | null): SearchResultScope {
  return workspaceId === null || slug === null ? { kind: 'global' } : { kind: 'workspace', id: workspaceId, slug };
}
