import type { EntityManager } from 'typeorm';

export const WORKSPACE_CLEANUP = Symbol('WORKSPACE_CLEANUP');

/**
 * Participates in the Workspace delete transaction: removes the Workspace's scoped resources (and durably captures
 * whatever must be cleaned up after commit) so the restricting FKs of ScopedEntity never block a delete.
 * Runs inside the caller's transaction, after the Workspace row is locked.
 */
export interface WorkspaceCleanup {
  deleteWorkspaceData(manager: EntityManager, workspaceId: string): Promise<void>;
}
