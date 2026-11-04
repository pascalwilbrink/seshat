import { Body, Controller, Get, Header, HttpCode, Inject, Param, Put, Post } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import {
  type ApiKeyDto,
  type CreateApiKeyInput,
  type CreatedApiKeyDto,
  type UpdateApiKeyInput,
  createApiKeySchema,
  updateApiKeySchema,
} from './api-key.dto.js';
import { ApiKeysService } from './api-keys.service.js';

/** Workspace-scoped key management only: there are no Global key routes. Responses are never cacheable. */
@Controller('workspaces/:workspaceId/api-keys')
export class ApiKeysController {
  constructor(@Inject(ApiKeysService) private readonly keys: ApiKeysService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
  ): Promise<ApiKeyDto[]> {
    return this.keys.list(principal, scope);
  }

  @Post()
  @Header('Cache-Control', 'no-store')
  create(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Body(new ZodValidationPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ): Promise<CreatedApiKeyDto> {
    return this.keys.create(principal, scope, body);
  }

  @Put(':keyId')
  @Header('Cache-Control', 'no-store')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('keyId') keyId: string,
    @Body(new ZodValidationPipe(updateApiKeySchema)) body: UpdateApiKeyInput,
  ): Promise<ApiKeyDto> {
    return this.keys.update(principal, scope, keyId, body);
  }

  @Post(':keyId/revoke')
  @Header('Cache-Control', 'no-store')
  @HttpCode(200)
  revoke(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('keyId') keyId: string,
  ): Promise<ApiKeyDto> {
    return this.keys.revoke(principal, scope, keyId);
  }
}
