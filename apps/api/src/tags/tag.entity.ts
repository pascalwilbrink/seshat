import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique, UpdateDateColumn } from 'typeorm';
import { ScopedEntity } from '../scopes/scoped.entity.js';

/** Normalized tag name rule shared with the DB check: lowercase letters, digits, `-`, `_`, `.`, `:` and `/`. */
export const TAG_NAME_PATTERN = /^[a-z0-9_.:/-]+$/;
export const TAG_NAME_MAX_LENGTH = 50;

/**
 * A flat, scoped label. It deliberately knows nothing about files: Files join through `file_tags`, and a later
 * `memory_tags` join can reuse the same rows. Tags never grant access.
 */
@Entity({ name: 'tags' })
@Check('CK_tags_name_length', 'char_length("name") BETWEEN 1 AND 50')
@Check('CK_tags_name_format', `"name" ~ '^[a-z0-9_.:/-]+$'`)
@Unique('UQ_tags_id_scope_key', ['id', 'scopeKey'])
@Unique('UQ_tags_scope_key_name', ['scopeKey', 'name'])
export class Tag extends ScopedEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  /** DB-generated scope identity ('global' or the Workspace uuid); read-only. */
  @Column({
    name: 'scope_key',
    type: 'text',
    generatedType: 'STORED',
    asExpression: `CASE WHEN "workspace_id" IS NULL THEN 'global' ELSE "workspace_id"::text END`,
    insert: false,
    update: false,
  })
  scopeKey!: string;

  @Column({ name: 'name', type: 'varchar', length: TAG_NAME_MAX_LENGTH })
  name!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
