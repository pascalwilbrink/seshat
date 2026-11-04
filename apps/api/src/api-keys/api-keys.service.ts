import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthorizationService as AuthorizationServiceType } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { isUuid, type ScopeRef } from '../scopes/scope-ref.js';
import { WorkspacesService } from '../workspaces/workspace.service.js';
import type { ApiKeyDto, CreateApiKeyInput, CreatedApiKeyDto, UpdateApiKeyInput } from './api-key.dto.js';
import { toApiKeyDto } from './api-key.mapper.js';
import { ApiKeyStore, ApiKeyStoreError } from './api-key.store.js';

type Action = Parameters<AuthorizationServiceType['assertCan']>[1];

/**
 * Admin-only Workspace API key management. Every method takes the acting Principal and an explicit Workspace
 * ScopeRef. Access is decided by AuthorizationService (through WorkspacesService.resolve) BEFORE any
 * existence-sensitive lookup, so a denied, foreign and missing Workspace all give the identical 404 for keys.
 * Keys are always looked up by Workspace id and key id together. There are no Global keys.
 */
@Injectable()
export class ApiKeysService {
  constructor(
    @Inject(ApiKeyStore) private readonly store: ApiKeyStore,
    @Inject(WorkspacesService) private readonly workspaces: WorkspacesService,
  ) {}

  private async authorize(principal: Principal, action: Action, scope: ScopeRef): Promise<string> {
    if (scope.kind !== 'workspace') throw new NotFoundException('Not Found');
    await this.workspaces.resolve(principal, action, scope);
    return scope.workspaceId;
  }

  async list(principal: Principal, scope: ScopeRef): Promise<ApiKeyDto[]> {
    const workspaceId = await this.authorize(principal, 'apiKey:list', scope);
    const now = new Date();
    return (await this.store.list(workspaceId)).map((r) => toApiKeyDto(r, now));
  }

  async create(principal: Principal, scope: ScopeRef, input: CreateApiKeyInput): Promise<CreatedApiKeyDto> {
    const workspaceId = await this.authorize(principal, 'apiKey:create', scope);
    try {
      const generated = await this.store.create({
        workspaceId,
        name: input.name,
        permissions: input.permissions,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      });
      return { apiKey: toApiKeyDto(generated.record), secret: generated.secret };
    } catch (err) {
      if (err instanceof ApiKeyStoreError && err.code === 'workspace_not_found') throw new NotFoundException('Not Found');
      throw err; // sanitized by the global filter (fixed 500, class name only)
    }
  }

  async update(principal: Principal, scope: ScopeRef, keyId: string, input: UpdateApiKeyInput): Promise<ApiKeyDto> {
    const workspaceId = await this.authorize(principal, 'apiKey:update', scope);
    if (!isUuid(keyId)) throw new NotFoundException('Not Found');
    const result = await this.store.update(workspaceId, keyId, input);
    if (result === 'not_found') throw new NotFoundException('Not Found');
    if (result === 'revoked') throw new ConflictException('API key is revoked and cannot be edited');
    return toApiKeyDto(result);
  }

  /** Soft, immediate and irreversible. Repeating it is safe and keeps the original revocation time. */
  async revoke(principal: Principal, scope: ScopeRef, keyId: string): Promise<ApiKeyDto> {
    const workspaceId = await this.authorize(principal, 'apiKey:revoke', scope);
    if (!isUuid(keyId)) throw new NotFoundException('Not Found');
    const record = await this.store.revoke(workspaceId, keyId);
    if (!record) throw new NotFoundException('Not Found');
    return toApiKeyDto(record);
  }
}
