import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import type { ResourceUsageDto, UsageOverviewDto, UsageTopDto, UsageUnusedDto } from './usage.dto.js';
import { UsageService } from './usage.service.js';

/**
 * Admin-only usage analytics, per scope: `files/:fileId/usage`, `memories/:memoryId/usage`, `usage/top`,
 * `usage/unused` and `usage/overview` under `/api/global` and `/api/workspaces/:workspaceId`.
 */
@Controller()
export class UsageController {
  constructor(@Inject(UsageService) private readonly usage: UsageService) {}

  @Get('global/files/:fileId/usage')
  fileUsageGlobal(@CurrentPrincipal() p: Principal, @Param('fileId') id: string, @Query() q: unknown): Promise<ResourceUsageDto> {
    return this.usage.resourceUsage(p, globalScope(), 'file', id, q);
  }

  @Get('workspaces/:workspaceId/files/:fileId/usage')
  fileUsage(
    @CurrentPrincipal() p: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') id: string,
    @Query() q: unknown,
  ): Promise<ResourceUsageDto> {
    return this.usage.resourceUsage(p, scope, 'file', id, q);
  }

  @Get('global/memories/:memoryId/usage')
  memoryUsageGlobal(@CurrentPrincipal() p: Principal, @Param('memoryId') id: string, @Query() q: unknown): Promise<ResourceUsageDto> {
    return this.usage.resourceUsage(p, globalScope(), 'memory', id, q);
  }

  @Get('workspaces/:workspaceId/memories/:memoryId/usage')
  memoryUsage(
    @CurrentPrincipal() p: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('memoryId') id: string,
    @Query() q: unknown,
  ): Promise<ResourceUsageDto> {
    return this.usage.resourceUsage(p, scope, 'memory', id, q);
  }

  @Get('global/usage/top')
  topGlobal(@CurrentPrincipal() p: Principal, @Query() q: unknown): Promise<UsageTopDto> {
    return this.usage.top(p, globalScope(), q);
  }

  @Get('workspaces/:workspaceId/usage/top')
  top(@CurrentPrincipal() p: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef, @Query() q: unknown): Promise<UsageTopDto> {
    return this.usage.top(p, scope, q);
  }

  @Get('global/usage/unused')
  unusedGlobal(@CurrentPrincipal() p: Principal, @Query() q: unknown): Promise<UsageUnusedDto> {
    return this.usage.unused(p, globalScope(), q);
  }

  @Get('workspaces/:workspaceId/usage/unused')
  unused(@CurrentPrincipal() p: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef, @Query() q: unknown): Promise<UsageUnusedDto> {
    return this.usage.unused(p, scope, q);
  }

  @Get('global/usage/overview')
  overviewGlobal(@CurrentPrincipal() p: Principal, @Query() q: unknown): Promise<UsageOverviewDto> {
    return this.usage.overview(p, globalScope(), q);
  }

  @Get('workspaces/:workspaceId/usage/overview')
  overview(@CurrentPrincipal() p: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef, @Query() q: unknown): Promise<UsageOverviewDto> {
    return this.usage.overview(p, scope, q);
  }
}
