import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import type { Repository } from 'typeorm';
import { Workspace } from '../workspaces/workspace.entity.js';
import { AuthService } from './auth.service.js';
import type { Principal } from './principal.js';

export interface AdminSessionDto {
  kind: 'admin';
  username: string;
}

/** Safe identity of an API key: its Workspace and permissions only. No key id, prefix, digest or secret. */
export interface ApiKeySessionDto {
  kind: 'apiKey';
  workspace: { id: string; slug: string; name: string };
  permissions: Permission[];
}

export type SessionDto = AdminSessionDto | ApiKeySessionDto;

@Injectable()
export class IdentityService {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(getRepositoryToken(Workspace)) private readonly workspaces: Repository<Workspace>,
  ) {}

  async describe(principal: Principal): Promise<SessionDto> {
    if (principal.kind === 'admin') return { kind: 'admin', username: this.auth.adminUsername };
    const ws = await this.workspaces.findOne({ where: { id: principal.workspaceId } });
    // The Workspace cascade-deletes its keys, so this only happens in a race: treat it as unauthenticated.
    if (!ws) throw new UnauthorizedException('Unauthorized');
    return {
      kind: 'apiKey',
      workspace: { id: ws.id, slug: ws.slug, name: ws.name },
      permissions: [...principal.permissions],
    };
  }
}
