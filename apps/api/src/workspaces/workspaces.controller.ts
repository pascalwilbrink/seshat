import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import {
  type CreateWorkspaceInput,
  type DeleteWorkspaceInput,
  type UpdateWorkspaceInput,
  type WorkspaceDto,
  createWorkspaceSchema,
  deleteWorkspaceSchema,
  updateWorkspaceSchema,
} from './workspace.dto.js';
import { WorkspacesService } from './workspace.service.js';

/** Routes carry the scope explicitly: `/api/global/workspaces` and `/api/workspaces/:workspaceId`. */
@Controller()
export class WorkspacesController {
  constructor(@Inject(WorkspacesService) private readonly workspaces: WorkspacesService) {}

  @Get('global/workspaces')
  list(@CurrentPrincipal() principal: Principal): Promise<WorkspaceDto[]> {
    return this.workspaces.list(principal, globalScope());
  }

  @Post('global/workspaces')
  create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createWorkspaceSchema)) body: CreateWorkspaceInput,
  ): Promise<WorkspaceDto> {
    return this.workspaces.create(principal, globalScope(), body);
  }

  @Get('workspaces/:workspaceId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
  ): Promise<WorkspaceDto> {
    return this.workspaces.get(principal, scope);
  }

  @Put('workspaces/:workspaceId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(updateWorkspaceSchema)) body: UpdateWorkspaceInput,
  ): Promise<WorkspaceDto> {
    return this.workspaces.update(principal, scope, body);
  }

  @Delete('workspaces/:workspaceId')
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(deleteWorkspaceSchema)) body: DeleteWorkspaceInput,
  ): Promise<void> {
    return this.workspaces.remove(principal, scope, body.slug);
  }
}
