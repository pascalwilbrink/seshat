import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import { type RenameTagInput, type TagDto, renameTagSchema } from './tag.dto.js';
import { TagsService } from './tags.service.js';

/** Tags are created only by assigning names to files; these routes list, rename and delete them per scope. */
@Controller()
export class TagsController {
  constructor(@Inject(TagsService) private readonly tags: TagsService) {}

  @Get('global/tags')
  listGlobal(@CurrentPrincipal() principal: Principal): Promise<TagDto[]> {
    return this.tags.list(principal, globalScope());
  }

  @Patch('global/tags/:tagId')
  renameGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('tagId') tagId: string,
    @Body(new ZodValidationPipe(renameTagSchema)) body: RenameTagInput,
  ): Promise<TagDto> {
    return this.tags.rename(principal, globalScope(), tagId, body);
  }

  @Delete('global/tags/:tagId')
  @HttpCode(204)
  removeGlobal(@CurrentPrincipal() principal: Principal, @Param('tagId') tagId: string): Promise<void> {
    return this.tags.remove(principal, globalScope(), tagId);
  }

  @Get('workspaces/:workspaceId/tags')
  listWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
  ): Promise<TagDto[]> {
    return this.tags.list(principal, scope);
  }

  @Patch('workspaces/:workspaceId/tags/:tagId')
  renameWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('tagId') tagId: string,
    @Body(new ZodValidationPipe(renameTagSchema)) body: RenameTagInput,
  ): Promise<TagDto> {
    return this.tags.rename(principal, scope, tagId, body);
  }

  @Delete('workspaces/:workspaceId/tags/:tagId')
  @HttpCode(204)
  removeWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('tagId') tagId: string,
  ): Promise<void> {
    return this.tags.remove(principal, scope, tagId);
  }
}
