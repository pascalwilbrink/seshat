import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { ScopedEntity } from '../scopes/scoped.entity.js';

/** A scoped, optional grouping of files. Not a security boundary: it never grants access. */
@Entity({ name: 'collections' })
@Check('CK_collections_name_length', 'char_length("name") BETWEEN 1 AND 100')
@Check('CK_collections_name_not_blank', `btrim("name") <> ''`)
// The case-insensitive unique index on (scope_key, lower(name)) is an expression index owned by the migration.
export class Collection extends ScopedEntity {
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

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
