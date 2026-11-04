import { Check, Column, CreateDateColumn, Entity, Index, PrimaryColumn, Unique } from 'typeorm';

/**
 * A durable "this stored object must be removed" record. Written in the same transaction that deletes the owning rows,
 * so a crash, a missed in-process event or a failing storage backend can never lose the key. It deliberately has no
 * foreign key to `workspaces` or `files`: the rows it outlives are exactly the ones being deleted.
 * The key is internal and never logged or returned; diagnose by `id` / `resource_id`.
 */
@Entity({ name: 'storage_cleanup_intents' })
@Unique('UQ_storage_cleanup_intents_storage_key', ['storageKey'])
@Check('CK_storage_cleanup_intents_attempts', '"attempts" >= 0')
@Index('IDX_storage_cleanup_intents_next_attempt_at', ['nextAttemptAt'])
@Index('IDX_storage_cleanup_intents_resource_id', ['resourceId'])
export class StorageCleanupIntent {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'storage_key', type: 'varchar', length: 512 })
  storageKey!: string;

  /** What owned the object, e.g. 'file'. */
  @Column({ name: 'resource_type', type: 'varchar', length: 32 })
  resourceType!: string;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId!: string;

  /** 'global' or a Workspace uuid (no FK on purpose). */
  @Column({ name: 'scope_key', type: 'text' })
  scopeKey!: string;

  @Column({ name: 'attempts', type: 'integer', default: 0 })
  attempts!: number;

  /** Due time; also the claim lease while an attempt is running. */
  @Column({ name: 'next_attempt_at', type: 'timestamp with time zone', default: () => 'now()' })
  nextAttemptAt!: Date;

  /** Error class name of the last failure only; never a message or path. */
  @Column({ name: 'last_error', type: 'varchar', length: 100, nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp with time zone' })
  createdAt!: Date;
}
