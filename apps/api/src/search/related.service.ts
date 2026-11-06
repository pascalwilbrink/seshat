import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { UsageCollector } from '../usage/usage-request-context.js';
import { stageRetrieved } from '../usage/usage-staging.js';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { isUuid, type ScopeRef } from '../scopes/scope-ref.js';
import { RetrievalService } from './retrieval.service.js';
import { annSettingsFor, queryScopeOf, RetrievalRepository } from './retrieval.repository.js';
import { type GlobalRelatedQuery, type WorkspaceRelatedQuery, toRelatedRequest } from './related-request.dto.js';
import { type RelatedResponse, toRelatedMemoryResult } from './search-result.dto.js';

/**
 * Nearest active Memories to a stored seed Memory. Order is fixed: authorize (search AND memories:read, plus
 * global:read when Global is expanded), confirm the route scope exists, look the seed up inside the ROUTE scope only
 * (a foreign, ungranted or malformed id is indistinguishable from a missing one), then rank candidates with the scope,
 * type, active and not-self predicates inside SQL. The query embedding provider is never called.
 */
@Injectable()
export class RelatedMemoriesService {
  private readonly repo = new RetrievalRepository();

  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Optional() @Inject(UsageCollector) private readonly usage?: UsageCollector,
  ) {}

  async related(
    principal: Principal,
    scope: ScopeRef,
    seedId: string,
    query: GlobalRelatedQuery | WorkspaceRelatedQuery,
  ): Promise<RelatedResponse> {
    const request = toRelatedRequest(query);
    const plan = this.authorization.authorizeSearch(principal, scope, { types: ['memories'], includeGlobal: request.includeGlobal });
    if (scope.kind === 'workspace') {
      const rows = (await this.dataSource.query(`SELECT 1 FROM "workspaces" WHERE "id" = $1`, [scope.workspaceId])) as unknown[];
      if (rows.length === 0) throw new NotFoundException('Not Found');
    }
    if (!isUuid(seedId)) throw new NotFoundException('Not Found');

    const routeScope = queryScopeOf([scope]);
    const candidateScope = queryScopeOf(plan.scopes);
    return this.dataSource.transaction(async (m) => {
      const seed = await this.repo.loadSeedVector(m, routeScope, seedId.toLowerCase());
      if (!seed) throw new NotFoundException('Not Found');
      // The seed was requested by id: a read, even when it has no embedding and nothing is returned.
      this.usage?.stage({ resourceKind: 'memory', resourceId: seed.id, scope, accessKind: 'read' });
      if (seed.vector === null) return { results: [] };

      const wanted = request.limit;
      const settings = annSettingsFor(await this.retrieval.vectorVersion(m), Math.max(wanted * 4, wanted));
      await this.repo.applyAnnSettings(m, settings);
      const input = { scope: candidateScope, seedId: seed.id, vector: seed.vector, types: request.types, limit: wanted };
      let rows = await this.repo.nearestMemories(m, { ...input, exact: false });
      if (rows.length < wanted) rows = await this.repo.nearestMemories(m, { ...input, exact: true });

      const loaded = await this.repo.loadMemories(m, candidateScope, rows.map((r) => r.id), false);
      const results = [];
      for (const r of rows) {
        const row = loaded.get(r.id);
        if (row) results.push(toRelatedMemoryResult({ ...row, distance: r.distance }));
      }
      stageRetrieved(this.usage, results);
      return { results };
    });
  }
}
