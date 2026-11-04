import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { workspaceScope } from '../scopes/scope-ref.js';
import type { WorkspaceCleanup } from '../workspaces/workspace-cleanup.js';
import { StorageCleanupService } from './storage-cleanup.service.js';

/**
 * Removes Files, their tag joins, Collections and Tags of one Workspace in FK-safe order. The keys of all originals
 * are written to the persistent cleanup ledger in the same transaction, before the file rows disappear.
 */
@Injectable()
export class WorkspaceDataCleanup implements WorkspaceCleanup {
  constructor(@Inject(StorageCleanupService) private readonly cleanup: StorageCleanupService) {}

  async deleteWorkspaceData(manager: EntityManager, workspaceId: string): Promise<void> {
    const id = workspaceId.toLowerCase();
    await this.cleanup.deleteScopedFilesWithIntents(manager, workspaceScope(id)); // intents, file_tags, files
    await manager.query(`DELETE FROM "collections" WHERE "scope_key" = $1`, [id]);
    await manager.query(`DELETE FROM "tags" WHERE "scope_key" = $1`, [id]);
  }
}
