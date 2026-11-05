import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Join between a Memory and a shared scoped Tag. `scope_key` is part of both composite FKs
 * `(memory_id, scope_key)` and `(tag_id, scope_key)`, so a join across scopes cannot exist. Deleting either side
 * removes the join row only. (The FKs are created by the migration.)
 */
@Entity({ name: 'memory_tags' })
@Index('IDX_memory_tags_tag_id', ['tagId'])
export class MemoryTag {
  @PrimaryColumn({ name: 'memory_id', type: 'uuid' })
  memoryId!: string;

  @PrimaryColumn({ name: 'tag_id', type: 'uuid' })
  tagId!: string;

  @Column({ name: 'scope_key', type: 'text' })
  scopeKey!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;
}
