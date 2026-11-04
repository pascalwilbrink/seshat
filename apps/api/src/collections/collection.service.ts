import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid, scopeColumns } from '../scopes/scope-ref.js';
import type { CollectionDto, CreateCollectionInput, UpdateCollectionInput } from './collection.dto.js';
import { type CollectionRow, toCollectionDto } from './collection.mapper.js';

/** The generated `scope_key` value for a scope: 'global' or the Workspace uuid. Every query below filters on it. */
export function scopeKeyOf(scope: ScopeRef): string {
  return scope.kind === 'global' ? 'global' : scope.workspaceId;
}

function pgCode(err: unknown): string | undefined {
  return (err as { driverError?: { code?: string } } | null)?.driverError?.code;
}

/** Collection row plus the count of files in the same scope (the composite FK keeps members in-scope anyway). */
const SELECT_WITH_COUNT = `SELECT c."id", c."name", c."description", c."created_at", c."updated_at",
  (SELECT count(*) FROM "files" f WHERE f."collection_id" = c."id" AND f."scope_key" = c."scope_key") AS "file_count"
  FROM "collections" c`;

/**
 * Collections of one scope. Every method takes the acting Principal and an explicit ScopeRef; authorization
 * (AuthorizationService.assertCan) always runs before the first query, so a missing, foreign and denied
 * resource are indistinguishable. A Collection never grants access to its files.
 */
@Injectable()
export class CollectionsService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
  ) {}

  async list(principal: Principal, scope: ScopeRef): Promise<CollectionDto[]> {
    this.authorization.assertCan(principal, 'collection.list', scope);
    await this.assertScopeExists(this.dataSource.manager, scope);
    const rows = (await this.dataSource.query(
      `${SELECT_WITH_COUNT} WHERE c."scope_key" = $1 ORDER BY lower(c."name"), c."id"`,
      [scopeKeyOf(scope)],
    )) as CollectionRow[];
    return rows.map(toCollectionDto);
  }

  async get(principal: Principal, scope: ScopeRef, id: string): Promise<CollectionDto> {
    this.authorization.assertCan(principal, 'collection.get', scope);
    return toCollectionDto(await this.findOne(this.dataSource.manager, scope, id));
  }

  async create(principal: Principal, scope: ScopeRef, input: CreateCollectionInput): Promise<CollectionDto> {
    this.authorization.assertCan(principal, 'collection.create', scope);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const cols = scopeColumns(scope);
        const inserted = (await manager.query(
          `INSERT INTO "collections" ("scope", "workspace_id", "name", "description") VALUES ($1, $2, $3, $4) RETURNING "id"`,
          [cols.scope, cols.workspaceId, input.name, input.description ?? null],
        )) as { id: string }[];
        return toCollectionDto(await this.findOne(manager, scope, inserted[0]!.id));
      });
    } catch (err) {
      this.rethrowKnown(err);
    }
  }

  async update(principal: Principal, scope: ScopeRef, id: string, input: UpdateCollectionInput): Promise<CollectionDto> {
    this.authorization.assertCan(principal, 'collection.update', scope);
    this.requireUuid(id);
    try {
      return await this.dataSource.transaction(async (manager) => {
        const current = await this.findOne(manager, scope, id);
        const name = input.name ?? current.name;
        const description = input.description === undefined ? current.description : input.description;
        await manager.query(
          `UPDATE "collections" SET "name" = $1, "description" = $2, "updated_at" = now() WHERE "id" = $3 AND "scope_key" = $4`,
          [name, description, id, scopeKeyOf(scope)],
        );
        return toCollectionDto(await this.findOne(manager, scope, id));
      });
    } catch (err) {
      this.rethrowKnown(err);
    }
  }

  /** Deletes the Collection only. Its files and their tags are kept; their membership is cleared in the same transaction. */
  async remove(principal: Principal, scope: ScopeRef, id: string): Promise<void> {
    this.authorization.assertCan(principal, 'collection.delete', scope);
    this.requireUuid(id);
    const key = scopeKeyOf(scope);
    try {
      await this.dataSource.transaction(async (manager) => {
        const found = (await manager.query(
          `SELECT "id" FROM "collections" WHERE "id" = $1 AND "scope_key" = $2 FOR UPDATE`,
          [id, key],
        )) as unknown[];
        if (found.length === 0) throw new NotFoundException('Not Found');
        await manager.query(`UPDATE "files" SET "collection_id" = NULL WHERE "collection_id" = $1 AND "scope_key" = $2`, [id, key]);
        await manager.query(`DELETE FROM "collections" WHERE "id" = $1 AND "scope_key" = $2`, [id, key]);
      });
    } catch (err) {
      this.rethrowKnown(err);
    }
  }

  /**
   * Internal membership validator for file upload/update, run inside the caller's transaction. No Collection (null or
   * undefined) is valid. Otherwise the id must name a Collection of exactly this scope; a malformed, unknown or
   * other-scope id gives the same 400 and the lookup is constrained to the scope, so a foreign Collection is never read.
   */
  async resolveMembership(manager: EntityManager, scope: ScopeRef, collectionId: string | null | undefined): Promise<string | null> {
    if (collectionId === null || collectionId === undefined) return null;
    const invalid = () => new BadRequestException('Invalid collection');
    if (!isUuid(collectionId)) throw invalid();
    const rows = (await manager.query(`SELECT "id" FROM "collections" WHERE "id" = $1 AND "scope_key" = $2`, [
      collectionId.toLowerCase(),
      scopeKeyOf(scope),
    ])) as { id: string }[];
    if (rows.length === 0) throw invalid();
    return rows[0]!.id;
  }

  private requireUuid(id: string): void {
    if (!isUuid(id)) throw new NotFoundException('Not Found');
  }

  private async findOne(manager: EntityManager, scope: ScopeRef, id: string): Promise<CollectionRow> {
    this.requireUuid(id);
    const rows = (await manager.query(`${SELECT_WITH_COUNT} WHERE c."id" = $1 AND c."scope_key" = $2`, [
      id.toLowerCase(),
      scopeKeyOf(scope),
    ])) as CollectionRow[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
    return rows[0]!;
  }

  /** A Workspace scope whose Workspace does not exist behaves like any missing resource. Global is not a Workspace row. */
  private async assertScopeExists(manager: EntityManager, scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await manager.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }

  private rethrowKnown(err: unknown): never {
    if (err instanceof NotFoundException) throw err;
    switch (pgCode(err)) {
      case '23505':
        throw new ConflictException('A Collection with this name already exists');
      case '23503': // the Workspace vanished before the insert
        throw new NotFoundException('Not Found');
      case '23514':
      case '22001':
      case '22P02':
        throw new BadRequestException('Invalid request');
      default:
        throw err;
    }
  }
}
