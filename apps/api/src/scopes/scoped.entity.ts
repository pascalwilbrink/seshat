import { Check, Column, Index, JoinColumn, ManyToOne } from 'typeorm';
import { Workspace } from '../workspaces/workspace.entity.js';

/** The exact DB rule: `workspace_id` is null if and only if the scope is Global. */
export const SCOPE_CHECK_EXPRESSION =
  `("scope" = 'global' AND "workspace_id" IS NULL) OR ("scope" = 'workspace' AND "workspace_id" IS NOT NULL)`;

/**
 * Base class for every scoped resource: extend it from an `@Entity` and the table gets
 * `scope`, `workspace_id` (FK to workspaces), the null-iff-global check and a (scope, workspace_id) index.
 * The check, index and relation are declared on the base and inherited through TypeORM's inheritance tree.
 */
@Check('CK_scope_workspace_consistency', SCOPE_CHECK_EXPRESSION)
@Index(['scope', 'workspaceId'])
export abstract class ScopedEntity {
  @Column({ name: 'scope', type: 'varchar', length: 16 })
  scope!: 'global' | 'workspace';

  @Column({ name: 'workspace_id', type: 'uuid', nullable: true })
  workspaceId!: string | null;

  /** Restricting FK: a Workspace with data cannot be hard-deleted until its data is cleaned up. */
  @ManyToOne(() => Workspace, { nullable: true, onDelete: 'RESTRICT', onUpdate: 'RESTRICT' })
  @JoinColumn({ name: 'workspace_id' })
  workspace?: Workspace | null;
}
