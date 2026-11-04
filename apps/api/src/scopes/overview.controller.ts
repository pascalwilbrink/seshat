import { Controller, Get, Inject, Param } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import type { OverviewDto } from '../workspaces/workspace.dto.js';
import { OverviewService } from './overview.service.js';
import { WorkspaceScopePipe } from './scope-params.pipe.js';
import { type ScopeRef, globalScope } from './scope-ref.js';

@Controller()
export class OverviewController {
  constructor(@Inject(OverviewService) private readonly overview: OverviewService) {}

  @Get('global/overview')
  global(@CurrentPrincipal() principal: Principal): Promise<OverviewDto> {
    return this.overview.get(principal, globalScope());
  }

  @Get('workspaces/:workspaceId/overview')
  workspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
  ): Promise<OverviewDto> {
    return this.overview.get(principal, scope);
  }
}
