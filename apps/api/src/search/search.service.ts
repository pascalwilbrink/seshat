import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import { RetrievalService } from './retrieval.service.js';
import { type GlobalSearchRequest, type WorkspaceSearchRequest, toSearchRequest } from './search-request.dto.js';
import type { SearchResponse } from './search-result.dto.js';

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

  private async assertScopeExists(scope: ScopeRef): Promise<void> {
    if (scope.kind === 'global') return;
    const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
    if (rows.length === 0) throw new NotFoundException('Not Found');
  }
}
