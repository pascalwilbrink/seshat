import { Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import type { FileDto } from '../files/file.dto.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import type { ChunkPage } from './chunk.dto.js';
import { ChunksService } from './chunks.service.js';
import { type ReindexScopeResult, ReindexService } from './reindex.service.js';

/**
 * Ingestion operations on Files, in Global (`/api/global/files/...`) and in a Workspace
 * (`/api/workspaces/:workspaceId/files/...`):
 * - `POST .../files/:fileId/reindex` (`files:write`) sets one file to `pending` and queues it; 202 with the file.
 * - `POST .../files/reindex` (admin only) does the same for every file of the scope; 202 with counts.
 * - `GET .../files/:fileId/chunks` (`files:read`; query `limit`, `cursor`) pages the chunks in ordinal order.
 */
@Controller()
export class IngestionController {
  constructor(
    @Inject(ReindexService) private readonly reindex: ReindexService,
    @Inject(ChunksService) private readonly chunks: ChunksService,
  ) {}

  @Post('global/files/reindex')
  @HttpCode(202)
  reindexScopeGlobal(@CurrentPrincipal() principal: Principal): Promise<ReindexScopeResult> {
    return this.reindex.reindexScope(principal, globalScope());
  }

  @Post('workspaces/:workspaceId/files/reindex')
  @HttpCode(202)
  reindexScope(@CurrentPrincipal() principal: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef): Promise<ReindexScopeResult> {
    return this.reindex.reindexScope(principal, scope);
  }

  @Post('global/files/:fileId/reindex')
  @HttpCode(202)
  reindexGlobal(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string): Promise<FileDto> {
    return this.reindex.reindexFile(principal, globalScope(), fileId);
  }

  @Post('workspaces/:workspaceId/files/:fileId/reindex')
  @HttpCode(202)
  reindexFile(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
  ): Promise<FileDto> {
    return this.reindex.reindexFile(principal, scope, fileId);
  }

  @Get('global/files/:fileId/chunks')
  chunksGlobal(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string, @Query() query: unknown): Promise<ChunkPage> {
    return this.chunks.list(principal, globalScope(), fileId, query);
  }

  @Get('workspaces/:workspaceId/files/:fileId/chunks')
  chunksFile(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
    @Query() query: unknown,
  ): Promise<ChunkPage> {
    return this.chunks.list(principal, scope, fileId, query);
  }
}
