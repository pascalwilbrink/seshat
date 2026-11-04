import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import {
  type CollectionDto,
  type CreateCollectionInput,
  type UpdateCollectionInput,
  createCollectionSchema,
  updateCollectionSchema,
} from './collection.dto.js';
import { CollectionsService } from './collection.service.js';

/** Routes carry the scope explicitly: `/api/global/collections` and `/api/workspaces/:workspaceId/collections`. */
@Controller()
export class CollectionsController {
  constructor(@Inject(CollectionsService) private readonly collections: CollectionsService) {}

  @Get('global/collections')
  listGlobal(@CurrentPrincipal() principal: Principal): Promise<CollectionDto[]> {
    return this.collections.list(principal, globalScope());
  }

  @Post('global/collections')
  createGlobal(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(createCollectionSchema)) body: CreateCollectionInput,
  ): Promise<CollectionDto> {
    return this.collections.create(principal, globalScope(), body);
  }

  @Get('global/collections/:collectionId')
  getGlobal(@CurrentPrincipal() principal: Principal, @Param('collectionId') id: string): Promise<CollectionDto> {
    return this.collections.get(principal, globalScope(), id);
  }

  @Put('global/collections/:collectionId')
  updateGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('collectionId') id: string,
    @Body(new ZodValidationPipe(updateCollectionSchema)) body: UpdateCollectionInput,
  ): Promise<CollectionDto> {
    return this.collections.update(principal, globalScope(), id, body);
  }

  @Delete('global/collections/:collectionId')
  @HttpCode(204)
  removeGlobal(@CurrentPrincipal() principal: Principal, @Param('collectionId') id: string): Promise<void> {
    return this.collections.remove(principal, globalScope(), id);
  }

  @Get('workspaces/:workspaceId/collections')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
  ): Promise<CollectionDto[]> {
    return this.collections.list(principal, scope);
  }

  @Post('workspaces/:workspaceId/collections')
  create(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(createCollectionSchema)) body: CreateCollectionInput,
  ): Promise<CollectionDto> {
    return this.collections.create(principal, scope, body);
  }

  @Get('workspaces/:workspaceId/collections/:collectionId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('collectionId') id: string,
  ): Promise<CollectionDto> {
    return this.collections.get(principal, scope, id);
  }

  @Put('workspaces/:workspaceId/collections/:collectionId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('collectionId') id: string,
    @Body(new ZodValidationPipe(updateCollectionSchema)) body: UpdateCollectionInput,
  ): Promise<CollectionDto> {
    return this.collections.update(principal, scope, id, body);
  }

  @Delete('workspaces/:workspaceId/collections/:collectionId')
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('collectionId') id: string,
  ): Promise<void> {
    return this.collections.remove(principal, scope, id);
  }
}
