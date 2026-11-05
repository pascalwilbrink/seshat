import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import { type ContextSource, formatContext } from './context-formatter.js';
import { RetrievalService } from './retrieval.service.js';
import { type GlobalContextRequest, type WorkspaceContextRequest, type GlobalSearchRequest, type WorkspaceSearchRequest, toSearchRequest } from './search-request.dto.js';
import type { SearchResponse } from './search-result.dto.js';

/** Context response: the text block and exactly the sources it cites. No totals, no excluded or dropped-source data. */
export interface ContextResponse {
  context: string;
  sources: ContextSource[];
  degraded?: 'keyword_only';
}

/**
 * HTTP-facing search. Order is fixed: authorize (central policy, no I/O), then confirm the Workspace exists, then
 * retrieve (the only place the query is embedded). A denied call therefore never reaches embedding or retrieval.
 */
@Injectable()
export class SearchService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
  ) {}

  async search(principal: Principal, scope: ScopeRef, body: GlobalSearchRequest | WorkspaceSearchRequest): Promise<SearchResponse> {
    const request = toSearchRequest(body);
    const plan = this.authorization.authorizeSearch(principal, scope, { types: request.types, includeGlobal: request.includeGlobal });
    await this.assertScopeExists(scope);
    return this.retrieval.retrieve(plan, request);
  }

  /**
   * Same authorization, scope check, embedding fallback, filters and ranking as `search`; the ranked results are then
   * formatted into one budgeted, cited text block. `degraded` is carried over unchanged.
   */
  async context(principal: Principal, scope: ScopeRef, body: GlobalContextRequest | WorkspaceContextRequest): Promise<ContextResponse> {
    const { maxChars, ...searchBody } = body;
    const found = await this.search(principal, scope, searchBody);
    const { context, sources } = formatContext(found.results, maxChars);
    return found.degraded ? { context, sources, degraded: found.degraded } : { context, sources };
  }

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }
}
