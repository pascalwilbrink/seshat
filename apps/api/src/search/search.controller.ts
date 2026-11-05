import { Body, Controller, Header, HttpCode, Inject, Param, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import { SearchService } from './search.service.js';
import {
  type GlobalSearchRequest,
  type WorkspaceSearchRequest,
  globalSearchRequestSchema,
  workspaceSearchRequestSchema,
} from './search-request.dto.js';
import type { SearchResponse } from './search-result.dto.js';

/**
 * `POST /api/global/search` and `POST /api/workspaces/:workspaceId/search`. Read-only (POST carries the filter body),
 * answered with 200 and `Cache-Control: no-store`. The response has results and an optional `degraded` marker only.
 */
@Controller()
export class SearchController {
  constructor(@Inject(SearchService) private readonly search: SearchService) {}

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
}
