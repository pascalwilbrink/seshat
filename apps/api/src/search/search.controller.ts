import { Body, Controller, Get, Header, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import { RelatedMemoriesService } from './related.service.js';
import {
  type GlobalRelatedQuery,
  type WorkspaceRelatedQuery,
  globalRelatedQuerySchema,
  workspaceRelatedQuerySchema,
} from './related-request.dto.js';
import { type ContextResponse, SearchService } from './search.service.js';
import {
  type GlobalContextRequest,
  type GlobalSearchRequest,
  type WorkspaceContextRequest,
  globalContextRequestSchema,
  workspaceContextRequestSchema,
  type WorkspaceSearchRequest,
  globalSearchRequestSchema,
  workspaceSearchRequestSchema,
} from './search-request.dto.js';
import type { RelatedResponse, SearchResponse } from './search-result.dto.js';

/**
 * `POST .../search` and `POST .../context` (global and per Workspace). Read-only (POST carries the filter body),
 * answered with 200 and `Cache-Control: no-store`. The response has results and an optional `degraded` marker only.
 */
@Controller()
export class SearchController {
  constructor(
    @Inject(SearchService) private readonly search: SearchService,
    @Inject(RelatedMemoriesService) private readonly related: RelatedMemoriesService,
  ) {}

  @Get('global/memories/:memoryId/related')
  @Header('Cache-Control', 'no-store')
  relatedGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('memoryId') memoryId: string,
    @Query(new ZodValidationPipe(globalRelatedQuerySchema)) query: GlobalRelatedQuery,
  ): Promise<RelatedResponse> {
    return this.related.related(principal, globalScope(), memoryId, query);
  }

  @Get('workspaces/:workspaceId/memories/:memoryId/related')
  @Header('Cache-Control', 'no-store')
  relatedWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') memoryId: string,
    @Query(new ZodValidationPipe(workspaceRelatedQuerySchema)) query: WorkspaceRelatedQuery,
  ): Promise<RelatedResponse> {
    return this.related.related(principal, scope, memoryId, query);
  }

  @Post('global/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  searchGlobal(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(globalSearchRequestSchema)) body: GlobalSearchRequest,
  ): Promise<SearchResponse> {
    return this.search.search(principal, globalScope(), body);
  }

  @Post('workspaces/:workspaceId/search')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  searchWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(workspaceSearchRequestSchema)) body: WorkspaceSearchRequest,
  ): Promise<SearchResponse> {
    return this.search.search(principal, scope, body);
  }

  @Post('global/context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  contextGlobal(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(globalContextRequestSchema)) body: GlobalContextRequest,
  ): Promise<ContextResponse> {
    return this.search.context(principal, globalScope(), body);
  }

  @Post('workspaces/:workspaceId/context')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  contextWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(workspaceContextRequestSchema)) body: WorkspaceContextRequest,
  ): Promise<ContextResponse> {
    return this.search.context(principal, scope, body);
  }
}
