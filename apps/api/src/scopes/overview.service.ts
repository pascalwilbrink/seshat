import { Inject, Injectable } from '@nestjs/common';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import type { OverviewDto } from '../workspaces/workspace.dto.js';
import { GLOBAL_OVERVIEW, toWorkspaceOverviewDto } from '../workspaces/workspace.mapper.js';
import { WorkspacesService } from '../workspaces/workspace.service.js';
import type { ScopeRef } from './scope-ref.js';

/** Scoped metadata for the Overview page. Scope and principal are explicit arguments. */
@Injectable()
export class OverviewService {
  constructor(
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  async get(principal: Principal, scope: ScopeRef): Promise<OverviewDto> {
    if (scope.kind === 'global') {
      this.authorization.assertCan(principal, 'overview:read', scope);
      return GLOBAL_OVERVIEW;
    }
    return toWorkspaceOverviewDto(await this.workspaces.resolve(principal, 'overview:read', scope));
  }
}
