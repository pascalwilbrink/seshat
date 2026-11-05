import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import {
  type CreateMemoryInput,
  type CreateMemoryResult,
  type MemoryDto,
  type SupersedeMemoryInput,
  type UpdateMemoryInput,
  createMemorySchema,
  supersedeMemorySchema,
  updateMemorySchema,
} from './memory.dto.js';
import type { MemoryListPage } from './memory-list-query.js';
import { MemoriesService } from './memories.service.js';

interface StatusResponse {
  status(code: number): unknown;
}

/**
 * Memory lifecycle. `POST .../memories` answers 201 for a new Memory and 200 with `deduplicated: true` when an
 * identical active Memory was reused. `PUT` replaces all editable fields; there is no PATCH. `POST .../supersede` is
 * the explicit post-create state change. Provenance is never read from a request.
 */
@Controller()
export class MemoriesController {
  constructor(@Inject(MemoriesService) private readonly memories: MemoriesService) {}

  @Get('global/memories')
  listGlobal(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<MemoryListPage<MemoryDto>> {
    return this.memories.list(principal, globalScope(), query);
  }

  @Get('workspaces/:workspaceId/memories')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Query() query: unknown,
  ): Promise<MemoryListPage<MemoryDto>> {
    return this.memories.list(principal, scope, query);
  }

  @Get('global/memories/:memoryId')
  getGlobal(@CurrentPrincipal() principal: Principal, @Param('memoryId') memoryId: string): Promise<MemoryDto> {
    return this.memories.get(principal, globalScope(), memoryId);
  }

  @Get('workspaces/:workspaceId/memories/:memoryId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
  ): Promise<MemoryDto> {
    return this.memories.get(principal, scope, memoryId);
  }

  @Post('global/memories')
  createGlobal(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createMemorySchema)) body: CreateMemoryInput,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<CreateMemoryResult> {
    return this.create(principal, globalScope(), body, res);
  }

  @Post('workspaces/:workspaceId/memories')
  createInWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(createMemorySchema)) body: CreateMemoryInput,
    @Res({ passthrough: true }) res: StatusResponse,
  ): Promise<CreateMemoryResult> {
    return this.create(principal, scope, body, res);
  }

  @Put('global/memories/:memoryId')
  updateGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(updateMemorySchema)) body: UpdateMemoryInput,
  ): Promise<MemoryDto> {
    return this.memories.update(principal, globalScope(), memoryId, body);
  }

  @Put('workspaces/:workspaceId/memories/:memoryId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(updateMemorySchema)) body: UpdateMemoryInput,
  ): Promise<MemoryDto> {
    return this.memories.update(principal, scope, memoryId, body);
  }

  @Post('global/memories/:memoryId/supersede')
  @HttpCode(200)
  supersedeGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(supersedeMemorySchema)) body: SupersedeMemoryInput,
  ): Promise<MemoryDto> {
    return this.memories.supersede(principal, globalScope(), memoryId, body);
  }

  @Post('workspaces/:workspaceId/memories/:memoryId/supersede')
  @HttpCode(200)
  supersede(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
    @Body(new ZodValidationPipe(supersedeMemorySchema)) body: SupersedeMemoryInput,
  ): Promise<MemoryDto> {
    return this.memories.supersede(principal, scope, memoryId, body);
  }

  @Post('global/memories/:memoryId/retry-embedding')
  @HttpCode(202)
  retryEmbeddingGlobal(@CurrentPrincipal() principal: Principal, @Param('memoryId') memoryId: string): Promise<MemoryDto> {
    return this.memories.retryEmbedding(principal, globalScope(), memoryId);
  }

  @Post('workspaces/:workspaceId/memories/:memoryId/retry-embedding')
  @HttpCode(202)
  retryEmbedding(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
  ): Promise<MemoryDto> {
    return this.memories.retryEmbedding(principal, scope, memoryId);
  }

  @Delete('global/memories/:memoryId')
  @HttpCode(204)
  removeGlobal(@CurrentPrincipal() principal: Principal, @Param('memoryId') memoryId: string): Promise<void> {
    return this.memories.remove(principal, globalScope(), memoryId);
  }

  @Delete('workspaces/:workspaceId/memories/:memoryId')
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
  ): Promise<void> {
    return this.memories.remove(principal, scope, memoryId);
  }

  private async create(principal: Principal, scope: ScopeRef, body: CreateMemoryInput, res: StatusResponse): Promise<CreateMemoryResult> {
    const result = await this.memories.create(principal, scope, body);
    res.status(result.deduplicated ? 200 : 201);
    return result;
  }
}
