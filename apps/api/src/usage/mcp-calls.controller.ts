import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import type { McpCallDetailDto, McpCallListDto } from './mcp-calls.dto.js';
import { McpCallsService } from './mcp-calls.service.js';

/** Admin-only MCP call history: per Workspace, and across all Workspaces under `/api/global`. */
@Controller()
export class McpCallsController {
  constructor(@Inject(McpCallsService) private readonly calls: McpCallsService) {}

  @Get('global/mcp-calls')
  listGlobal(@CurrentPrincipal() p: Principal, @Query() q: unknown): Promise<McpCallListDto> {
    return this.calls.list(p, globalScope(), q);
  }

  @Get('global/mcp-calls/:callId')
  getGlobal(@CurrentPrincipal() p: Principal, @Param('callId') id: string): Promise<McpCallDetailDto> {
    return this.calls.get(p, globalScope(), id);
  }

  @Get('workspaces/:workspaceId/mcp-calls')
  list(@CurrentPrincipal() p: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef, @Query() q: unknown): Promise<McpCallListDto> {
    return this.calls.list(p, scope, q);
  }

  @Get('workspaces/:workspaceId/mcp-calls/:callId')
  get(@CurrentPrincipal() p: Principal, @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef, @Param('callId') id: string): Promise<McpCallDetailDto> {
    return this.calls.get(p, scope, id);
  }
}
