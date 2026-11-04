import { Check, Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/** Slug rule shared with the DB check: lowercase kebab-case, never the reserved `global`. */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const RESERVED_WORKSPACE_SLUG = 'global';

/** A Workspace. Global is a scope, never a row here. */
@Entity({ name: 'workspaces' })
@Check('CK_workspaces_name_length', 'char_length("name") BETWEEN 1 AND 100')
@Check('CK_workspaces_slug_format', `"slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND "slug" <> 'global'`)
export class Workspace {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'name', type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'slug', type: 'varchar', length: 100, unique: true })
  slug!: string;

  @Column({ name: 'description', type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamp with time zone' })
  updatedAt!: Date;
}
