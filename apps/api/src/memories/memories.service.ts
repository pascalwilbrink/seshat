import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import { TagsService, scopeKeyOf } from '../tags/tags.service.js';
import {
  type CreateMemoryInput,
  type CreateMemoryResult,
  type MemoryDto,
  type SupersedeMemoryInput,
  type UpdateMemoryInput,
  toMemoryDto,
} from './memory.dto.js';
import type { Memory } from './memory.entity.js';
import { memoryContentHash } from './memory-content.js';
import { encodeCursor } from '../files/file-list-query.js';
import { type MemoryListPage, parseMemoryListQuery } from './memory-list-query.js';
import { buildMemoryProvenance } from './memory-provenance.js';

const NOT_FOUND = 'Not Found';
/** Columns of a response; the embedding vector and the content hash are never selected for DTOs. */
const COLUMNS = `"id", "scope", "workspace_id", "type", "content", "title", "metadata", "confidence", "source", "status", "superseded_by",
  "created_by_kind", "created_by_key_id", "created_by_key_name", "client_name", "client_version", "embedding_model", "embedding_status", "created_at", "updated_at"`;

interface MemoryRow {
  id: string;
  scope: 'global' | 'workspace';
  workspace_id: string | null;
  type: Memory['type'];
  content: string;
  title: string | null;
  metadata: Record<string, unknown> | null;
  confidence: number | null;
  source: string | null;
  status: Memory['status'];
  superseded_by: string | null;
  created_by_kind: Memory['createdByKind'];
  created_by_key_id: string | null;
  created_by_key_name: string | null;
  client_name: string | null;
  client_version: string | null;
  embedding_model: string | null;
  embedding_status: Memory['embeddingStatus'];
  created_at: Date;
  updated_at: Date;
}

function pgCode(err: unknown): string | undefined {
  return (err as { driverError?: { code?: string }; code?: string } | null)?.driverError?.code ?? (err as { code?: string } | null)?.code;
}

const json = (v: Record<string, unknown> | null | undefined) => (v === null || v === undefined ? null : JSON.stringify(v));

function toDto(r: MemoryRow, tags: readonly string[]): MemoryDto {
  return toMemoryDto(
    {
      id: r.id,
      scope: r.scope,
      workspaceId: r.workspace_id,
      type: r.type,
      content: r.content,
      title: r.title,
      metadata: r.metadata,
      confidence: r.confidence,
      source: r.source,
      status: r.status,
      supersededBy: r.superseded_by,
      createdByKind: r.created_by_kind,
      createdByKeyId: r.created_by_key_id,
      createdByKeyName: r.created_by_key_name,
      clientName: r.client_name,
      clientVersion: r.client_version,
      embeddingModel: r.embedding_model,
      embeddingStatus: r.embedding_status,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    } as Memory,
    tags,
  );
}

/**
 * Scoped Memories: create (with exact-duplicate reuse and optional supersession), full-replacement update, explicit
 * post-create supersede and hard forget.
 *
 * Every operation authorizes through AuthorizationService before any existence-sensitive query, and every statement
 * is bound to the scope key, so an id from another scope behaves exactly like a missing one. Each mutation is one
 * transaction that locks the rows it touches (`FOR UPDATE`, in id order when more than one), so lifecycle changes
 * are serialized and a failure leaves nothing behind. Provenance is written once from the authenticated principal.
 * New or changed embedding inputs are stored as `pending` with the stale vector cleared.
 */
@Injectable()
export class MemoriesService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(TagsService) private readonly tags: TagsService,
  ) {}

  /**
   * `memory.list`: newest created first with a stable (created_at, id) order; the cursor carries the last row's
   * microsecond timestamp text and id. All filters run in SQL before pagination, every predicate is bound to this
   * scope's key, and tags are matched with EXISTS so a Memory never appears twice. Status defaults to active.
   * The text filter is a literal, case-insensitive substring of content or title (`position`, no LIKE wildcards).
   */
  async list(principal: Principal, scope: ScopeRef, rawQuery: unknown): Promise<MemoryListPage<MemoryDto>> {
    this.authorization.assertCan(principal, 'memory.list', scope);
    const q = parseMemoryListQuery(rawQuery);
    await this.assertScopeExists(scope);

    const scopeKey = scopeKeyOf(scope);
    const params: unknown[] = [scopeKey];
    const where = [`m."scope_key" = $1`];
    const bind = (value: unknown) => `$${params.push(value)}`;
    if (q.status !== 'all') where.push(`m."status" = ${bind(q.status)}`);
    if (q.type) where.push(`m."type" = ${bind(q.type)}`);
    if (q.createdFrom) where.push(`m."created_at" >= ${bind(q.createdFrom)}::timestamptz`);
    if (q.createdTo) where.push(`m."created_at" <= ${bind(q.createdTo)}::timestamptz`);
    if (q.updatedFrom) where.push(`m."updated_at" >= ${bind(q.updatedFrom)}::timestamptz`);
    if (q.updatedTo) where.push(`m."updated_at" <= ${bind(q.updatedTo)}::timestamptz`);
    if (q.text) {
      const p = bind(q.text);
      where.push(`(position(lower(${p}::text) in lower(m."content")) > 0 OR position(lower(${p}::text) in lower(coalesce(m."title", ''))) > 0)`);
    }
    if (q.tag) {
      where.push(
        `EXISTS (SELECT 1 FROM "memory_tags" mt JOIN "tags" t ON t."id" = mt."tag_id" AND t."scope_key" = mt."scope_key"
           WHERE mt."memory_id" = m."id" AND mt."scope_key" = m."scope_key" AND t."name" = ${bind(q.tag)})`,
      );
    }
    if (q.cursor) {
      where.push(`(m."created_at", m."id") < (${bind(q.cursor.createdAt)}::timestamptz, ${bind(q.cursor.id)}::uuid)`);
    }
    const cols = COLUMNS.split(',').map((c) => `m.${c.trim()}`).join(', ');
    const rows = (await this.dataSource.query(
      `SELECT ${cols}, to_char(m."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "cursor_ts"
       FROM "memories" m WHERE ${where.join(' AND ')}
       ORDER BY m."created_at" DESC, m."id" DESC LIMIT ${bind(q.limit + 1)}`,
      params,
    )) as (MemoryRow & { cursor_ts: string })[];

    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const tagRows = page.length
      ? ((await this.dataSource.query(
          `SELECT mt."memory_id", t."name" FROM "memory_tags" mt JOIN "tags" t ON t."id" = mt."tag_id" AND t."scope_key" = mt."scope_key"
           WHERE mt."scope_key" = $1 AND mt."memory_id" = ANY($2::uuid[]) ORDER BY t."name"`,
          [scopeKey, page.map((r) => r.id)],
        )) as { memory_id: string; name: string }[])
      : [];
    const tagsBy = new Map<string, string[]>();
    for (const r of tagRows) tagsBy.set(r.memory_id, [...(tagsBy.get(r.memory_id) ?? []), r.name]);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => toDto(r, tagsBy.get(r.id) ?? [])),
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.cursor_ts, id: last.id }) : null,
      hasMore,
      limit: q.limit,
    };
  }

  /** `memory.get`: one Memory of this scope; foreign, missing and ungranted ids are the same 404. */
  async get(principal: Principal, scope: ScopeRef, memoryId: string): Promise<MemoryDto> {
    this.authorization.assertCan(principal, 'memory.get', scope);
    if (!isUuid(memoryId)) throw new NotFoundException(NOT_FOUND);
    await this.assertScopeExists(scope);
    return this.load(this.dataSource.manager, scopeKeyOf(scope), memoryId.toLowerCase());
  }

  /**
   * `memory.remember`. An active Memory with the same scope, type and normalized content hash is reused
   * (`deduplicated: true`): requested tags are added, nothing else changes. With `supersedes`, the same-scope active
   * predecessor is locked first and marked superseded by the (new or reused) successor in the same transaction.
   * Superseding the reused Memory itself is rejected (400).
   */
  async create(principal: Principal, scope: ScopeRef, input: CreateMemoryInput): Promise<CreateMemoryResult> {
    this.authorization.assertCan(principal, 'memory.remember', scope);
    const supersedes = input.supersedes ?? null;
    if (supersedes !== null && !isUuid(supersedes)) throw new NotFoundException(NOT_FOUND);
    await this.assertScopeExists(scope);
    const provenance = buildMemoryProvenance(principal);
    const hash = memoryContentHash(input.content);
    const scopeKey = scopeKeyOf(scope);
    const cols = scopeColumns(scope);

    return this.transact(async (manager) => {
      let predecessor: string | null = null;
      if (supersedes !== null) {
        const [row] = await this.lock(manager, scopeKey, [supersedes.toLowerCase()]);
        if (!row) throw new NotFoundException(NOT_FOUND);
        if (row.status !== 'active') throw new ConflictException('The Memory to supersede is not active');
        predecessor = row.id;
      }

      let id: string | null = null;
      let deduplicated = false;
      for (let attempt = 0; attempt < 5 && id === null; attempt++) {
        const inserted = (await manager.query(
          `INSERT INTO "memories" ("scope", "workspace_id", "type", "content", "title", "metadata", "confidence", "source",
             "created_by_kind", "created_by_key_id", "created_by_key_name", "client_name", "client_version", "content_hash")
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)
           ON CONFLICT ("scope_key", "type", "content_hash") WHERE "status" = 'active' DO NOTHING RETURNING "id"`,
          [
            cols.scope,
            cols.workspaceId,
            input.type,
            input.content,
            input.title ?? null,
            json(input.metadata),
            input.confidence ?? null,
            input.source ?? null,
            provenance.createdByKind,
            provenance.createdByKeyId,
            provenance.createdByKeyName,
            provenance.clientName,
            provenance.clientVersion,
            hash,
          ],
        )) as { id: string }[];
        if (inserted.length > 0) {
          id = inserted[0]!.id;
          break;
        }
        // The conflicting row was committed by someone else; if it was superseded or forgotten meanwhile, insert again.
        const existing = (await manager.query(
          `SELECT "id" FROM "memories" WHERE "scope_key" = $1 AND "type" = $2 AND "content_hash" = $3 AND "status" = 'active' FOR UPDATE`,
          [scopeKey, input.type, hash],
        )) as { id: string }[];
        if (existing.length > 0) {
          id = existing[0]!.id;
          deduplicated = true;
        }
      }
      if (id === null) throw new ConflictException('The Memory could not be saved; try again');
      if (predecessor !== null && predecessor === id) throw new BadRequestException('A Memory cannot supersede itself');

      if (deduplicated) await this.tags.unionMemoryTags(manager, scope, id, input.tags ?? []);
      else await this.tags.replaceMemoryTags(manager, scope, id, input.tags ?? []);
      if (predecessor !== null) await this.markSuperseded(manager, scopeKey, predecessor, id);
      return { ...(await this.load(manager, scopeKey, id)), deduplicated };
    });
  }

  /**
   * `memory.update`: full replacement of type, content, title, metadata, confidence, source and tags. A superseded
   * Memory is immutable (409 naming only its successor id). The hash follows type and content; a collision with
   * another active Memory is a 409 that names nothing. Provenance never changes. A content or title change resets the
   * embedding to `pending` and clears the stale vector.
   */
  async update(principal: Principal, scope: ScopeRef, memoryId: string, input: UpdateMemoryInput): Promise<MemoryDto> {
    this.authorization.assertCan(principal, 'memory.update', scope);
    if (!isUuid(memoryId)) throw new NotFoundException(NOT_FOUND);
    await this.assertScopeExists(scope);
    const id = memoryId.toLowerCase();
    const scopeKey = scopeKeyOf(scope);
    return this.transact(async (manager) => {
      const [current] = (await manager.query(
        `SELECT "id", "status", "superseded_by", "content", "title" FROM "memories" WHERE "id" = $1 AND "scope_key" = $2 FOR UPDATE`,
        [id, scopeKey],
      )) as { status: string; superseded_by: string | null; content: string; title: string | null }[];
      if (!current) throw new NotFoundException(NOT_FOUND);
      if (current.status !== 'active') {
        throw new ConflictException({ statusCode: 409, message: 'A superseded Memory cannot be changed', supersededBy: current.superseded_by });
      }
      const embeddingInputChanged = current.content !== input.content || current.title !== (input.title ?? null);
      try {
        await manager.query(
          `UPDATE "memories" SET "type" = $3, "content" = $4, "title" = $5, "metadata" = $6::jsonb, "confidence" = $7, "source" = $8,
             "content_hash" = $9, "updated_at" = now(),
             "embedding" = CASE WHEN $10::boolean THEN NULL ELSE "embedding" END,
             "embedding_model" = CASE WHEN $10::boolean THEN NULL ELSE "embedding_model" END,
             "embedding_status" = CASE WHEN $10::boolean THEN 'pending' ELSE "embedding_status" END
           WHERE "id" = $1 AND "scope_key" = $2`,
          [
            id,
            scopeKey,
            input.type,
            input.content,
            input.title,
            json(input.metadata),
            input.confidence,
            input.source,
            memoryContentHash(input.content),
            embeddingInputChanged,
          ],
        );
      } catch (err) {
        if (pgCode(err) === '23505') throw new ConflictException('An active Memory with this type and content already exists');
        throw err;
      }
      await this.tags.replaceMemoryTags(manager, scope, id, input.tags);
      return this.load(manager, scopeKey, id);
    });
  }

  /**
   * `memory.supersede`: marks the existing active predecessor as superseded by the existing active successor, both in
   * this scope, atomically. Creates nothing and merges nothing; only the predecessor changes. Returns the predecessor.
   */
  async supersede(principal: Principal, scope: ScopeRef, predecessorId: string, input: SupersedeMemoryInput): Promise<MemoryDto> {
    this.authorization.assertCan(principal, 'memory.supersede', scope);
    if (!isUuid(predecessorId) || !isUuid(input.successorId)) throw new NotFoundException(NOT_FOUND);
    await this.assertScopeExists(scope);
    const pred = predecessorId.toLowerCase();
    const succ = input.successorId.toLowerCase();
    if (pred === succ) throw new BadRequestException('A Memory cannot supersede itself');
    const scopeKey = scopeKeyOf(scope);
    return this.transact(async (manager) => {
      const rows = await this.lock(manager, scopeKey, [pred, succ]);
      const p = rows.find((r) => r.id === pred);
      const s = rows.find((r) => r.id === succ);
      if (!p || !s) throw new NotFoundException(NOT_FOUND);
      if (p.status !== 'active' || s.status !== 'active') throw new ConflictException('Both Memories must be active');
      await this.markSuperseded(manager, scopeKey, pred, succ);
      return this.load(manager, scopeKey, pred);
    });
  }

  /**
   * `memory.forget`: hard delete of exactly this Memory in this scope. Its tag joins go with it; Memories that were
   * superseded by it stay superseded and lose the link; an independent successor is never touched.
   */
  async remove(principal: Principal, scope: ScopeRef, memoryId: string): Promise<void> {
    this.authorization.assertCan(principal, 'memory.forget', scope);
    if (!isUuid(memoryId)) throw new NotFoundException(NOT_FOUND);
    await this.assertScopeExists(scope);
    const id = memoryId.toLowerCase();
    const scopeKey = scopeKeyOf(scope);
    await this.transact(async (manager) => {
      const [row] = await this.lock(manager, scopeKey, [id]);
      if (!row) throw new NotFoundException(NOT_FOUND);
      await manager.query(`DELETE FROM "memories" WHERE "id" = $1 AND "scope_key" = $2`, [id, scopeKey]);
    });
  }

  /** Runs a transaction, retrying a few times on deadlock or serialization failure between lifecycle operations. */
  private async transact<T>(work: (manager: EntityManager) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.dataSource.transaction(work);
      } catch (err) {
        const code = pgCode(err);
        if ((code === '40P01' || code === '40001') && attempt < 4) continue;
        if (code === '40P01' || code === '40001') throw new ConflictException('The Memory is being changed; try again');
        if (code === '23503') throw new NotFoundException(NOT_FOUND); // Workspace or Memory removed meanwhile
        throw err;
      }
    }
  }

  /** Locks the given Memories of this scope in id order and returns those that exist. */
  private async lock(manager: EntityManager, scopeKey: string, ids: string[]): Promise<{ id: string; status: string }[]> {
    return (await manager.query(
      `SELECT "id", "status" FROM "memories" WHERE "id" = ANY($1::uuid[]) AND "scope_key" = $2 ORDER BY "id" FOR UPDATE`,
      [ids, scopeKey],
    )) as { id: string; status: string }[];
  }

  private async markSuperseded(manager: EntityManager, scopeKey: string, predecessor: string, successor: string): Promise<void> {
    await manager.query(
      `UPDATE "memories" SET "status" = 'superseded', "superseded_by" = $3, "updated_at" = now() WHERE "id" = $1 AND "scope_key" = $2`,
      [predecessor, scopeKey, successor],
    );
  }

  private async load(manager: EntityManager, scopeKey: string, id: string): Promise<MemoryDto> {
    const [row] = (await manager.query(`SELECT ${COLUMNS} FROM "memories" WHERE "id" = $1 AND "scope_key" = $2`, [id, scopeKey])) as MemoryRow[];
    if (!row) throw new NotFoundException(NOT_FOUND);
    const tags = (await manager.query(
      `SELECT t."name" FROM "memory_tags" mt JOIN "tags" t ON t."id" = mt."tag_id" AND t."scope_key" = mt."scope_key"
       WHERE mt."memory_id" = $1 AND mt."scope_key" = $2 ORDER BY t."name"`,
      [id, scopeKey],
    )) as { name: string }[];
    return toDto(row, tags.map((t) => t.name));
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException(NOT_FOUND);
  }
}
