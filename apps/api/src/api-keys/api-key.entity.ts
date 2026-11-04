import { Check, Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn, Unique } from 'typeorm';
import { Workspace } from '../workspaces/workspace.entity.js';

/**
 * A Workspace API key. Only the prefix and an HMAC of the full key are stored. Keys belong to exactly one
 * Workspace (there are no Global keys) and are deleted with it (ON DELETE CASCADE), revoked ones included.
 */
@Entity({ name: 'api_keys' })
@Check('CK_api_keys_name_length', 'char_length("name") BETWEEN 1 AND 100')
@Check('CK_api_keys_permissions_not_empty', 'cardinality("permissions") >= 1')
@Check('CK_api_keys_prefix_format', `"prefix" ~ '^[0-9A-Za-z]{8}$'`)
@Check('CK_api_keys_key_hmac_length', 'octet_length("key_hmac") = 32')
@Unique('UQ_api_keys_prefix', ['prefix'])
@Index('IDX_api_keys_workspace_id', ['workspaceId'])
export class ApiKey {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'workspace_id', type: 'uuid' })
  workspaceId!: string;

  @ManyToOne(() => Workspace, { nullable: false, onDelete: 'CASCADE', onUpdate: 'RESTRICT' })
  @JoinColumn({ name: 'workspace_id' })
  workspace?: Workspace;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'prefix', type: 'varchar', length: 8 })
  prefix!: string;

  /** HMAC-SHA-256 of the full key. Internal: never selected by default, never mapped to a DTO or logged. */
  @Column({ name: 'key_hmac', type: 'bytea', select: false })
  keyHmac?: Buffer;

  /** Permissions from the shared catalog (validated on write and on read). */
  @Column({ name: 'permissions', type: 'text', array: true })
  permissions!: string[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamp with time zone', nullable: true })
  expiresAt!: Date | null;

  @Column({ name: 'last_used_at', type: 'timestamp with time zone', nullable: true })
  lastUsedAt!: Date | null;

  @Column({ name: 'revoked_at', type: 'timestamp with time zone', nullable: true })
  revokedAt!: Date | null;
}
