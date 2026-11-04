import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { type DataSource, type EntityManager, type Repository } from 'typeorm';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import {
  type CreateWorkspaceInput,
  MAX_WORKSPACE_SLUG_LENGTH,
  type UpdateWorkspaceInput,
  type WorkspaceDto,
} from './workspace.dto.js';
import { RESERVED_WORKSPACE_SLUG, WORKSPACE_SLUG_PATTERN, Workspace } from './workspace.entity.js';
import { toWorkspaceDto } from './workspace.mapper.js';

export const WORKSPACE_DELETED_EVENT = 'workspace.deleted';
export interface WorkspaceDeletedEvent {
  id: string;
}

/** Minimal view of the DataSource used for the delete transaction (so tests can supply a failing one). */
export type TransactionRunner = Pick<DataSource, 'transaction'>;

/** Lowercase kebab-case slug from a name: non-alphanumerics become single hyphens, trimmed, length-capped. */
export function deriveSlug(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_WORKSPACE_SLUG_LENGTH)
    .replace(/-+$/g, '');
}

function pgCode(err: unknown): string | undefined {
  return (err as { driverError?: { code?: string } } | null)?.driverError?.code;
}

function requireGlobal(scope: ScopeRef): void {
  if (scope.kind !== 'global') throw new Error('Workspace management operations require the global scope');
}
function requireWorkspace(scope: ScopeRef): string {
  if (scope.kind !== 'workspace') throw new Error('This operation requires a Workspace scope');
  return scope.workspaceId;
}

/**
 * Workspace management. Every method takes the acting Principal and an explicit ScopeRef (no session-global
 * "current Workspace") and decides access only through AuthorizationService.assertCan. Authorization runs
 * before the lookup, and a missing Workspace throws the same NotFoundException a denial does, so a missing
 * and an inaccessible Workspace are indistinguishable.
 */
@Injectable()
export class WorkspacesService {
  private readonly logger = new Logger(WorkspacesService.name);

  constructor(
    @Inject(getRepositoryToken(Workspace)) private readonly repo: Repository<Workspace>,
    @Inject(getDataSourceToken()) private readonly dataSource: TransactionRunner,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(EventEmitter2) private readonly events: EventEmitter2,
  ) {}

  async list(principal: Principal, scope: ScopeRef): Promise<WorkspaceDto[]> {
    requireGlobal(scope);
    this.authorization.assertCan(principal, 'workspace:list', scope);
    const rows = await this.repo.find({ order: { name: 'ASC', id: 'ASC' } });
    return rows.map(toWorkspaceDto);
  }

  async create(principal: Principal, scope: ScopeRef, input: CreateWorkspaceInput): Promise<WorkspaceDto> {
    requireGlobal(scope);
    this.authorization.assertCan(principal, 'workspace:create', scope);
    const slug = input.slug ?? deriveSlug(input.name);
    if (!slug || slug === RESERVED_WORKSPACE_SLUG || !WORKSPACE_SLUG_PATTERN.test(slug)) {
      throw new BadRequestException(
        input.slug === undefined ? 'A valid slug could not be derived from the name; provide one' : 'Invalid slug',
      );
    }
    try {
      const saved = await this.repo.save(
        this.repo.create({ name: input.name, slug, description: input.description ?? null }),
      );
      return toWorkspaceDto(saved);
    } catch (err) {
      this.rethrowKnown(err);
    }
  }

  async get(principal: Principal, scope: ScopeRef): Promise<WorkspaceDto> {
    return toWorkspaceDto(await this.resolve(principal, 'workspace:read', scope));
  }

  async update(principal: Principal, scope: ScopeRef, input: UpdateWorkspaceInput): Promise<WorkspaceDto> {
    const workspace = await this.resolve(principal, 'workspace:update', scope);
    if (input.name !== undefined) workspace.name = input.name;
    if (input.description !== undefined) workspace.description = input.description;
    try {
      return toWorkspaceDto(await this.repo.save(workspace));
    } catch (err) {
      this.rethrowKnown(err);
    }
  }

  /** Hard delete. `confirmSlug` must equal the Workspace's slug exactly. Emits `workspace.deleted` only after commit. */
  async remove(principal: Principal, scope: ScopeRef, confirmSlug: string): Promise<void> {
    const workspace = await this.resolve(principal, 'workspace:delete', scope);
    if (confirmSlug !== workspace.slug) throw new BadRequestException('Slug confirmation does not match');
    let affected: number | null | undefined;
    try {
      affected = await this.dataSource.transaction(async (manager: EntityManager) => {
        const result = await manager.delete(Workspace, { id: workspace.id });
        return result.affected;
      });
    } catch (err) {
      this.rethrowKnown(err);
    }
    // Deleted concurrently between lookup and delete: same response as missing, and nothing to announce.
    if (!affected) throw new NotFoundException('Not Found');
    try {
      this.events.emit(WORKSPACE_DELETED_EVENT, { id: workspace.id } satisfies WorkspaceDeletedEvent);
    } catch (err) {
      // The deletion is committed; a failing listener must not turn it into an error response.
      this.logger.error(`workspace.deleted listener failed (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }

  /**
   * Internal (for sibling services such as Overview): authorizes the action first, then loads the row.
   * A denial and a missing Workspace both end in the identical 404.
   */
  async resolve(principal: Principal, action: Parameters<AuthorizationService['assertCan']>[1], scope: ScopeRef): Promise<Workspace> {
    const id = requireWorkspace(scope);
    this.authorization.assertCan(principal, action, scope);
    const workspace = await this.repo.findOne({ where: { id } });
    if (!workspace) throw new NotFoundException('Not Found');
    return workspace;
  }

  private rethrowKnown(err: unknown): never {
    switch (pgCode(err)) {
      case '23505':
        throw new ConflictException('A Workspace with this slug already exists');
      case '23503':
        throw new ConflictException('Workspace still has data and cannot be deleted');
      case '23514':
      case '22001':
      case '22P02':
        throw new BadRequestException('Invalid request');
      default:
        // Unknown driver/ORM errors are not leaked: the global filter answers a fixed 500.
        throw err;
    }
  }
}
