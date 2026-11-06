---
name: typeorm-snake-case-columns
description: "Use when writing or changing TypeORM entities or raw SQL: database tables and columns are snake_case, TypeScript fields stay camelCase."
managed-by: gildeboek@ea1386d
---

# TypeORM naming: snake_case in the database, camelCase in TypeScript

Database identifiers (tables, columns, foreign keys, join columns, indexes) are **snake_case**.
TypeScript class names and fields stay **PascalCase / camelCase**. The mapping is always written explicitly on the decorator.

## Rules

1. **Tables**: snake_case, plural. `@Entity({ name: 'job_runs' })` for `class JobRun`.
2. **Columns**: every multi-word field gets an explicit `name`:
   `@Column({ name: 'max_concurrent_jobs' }) maxConcurrentJobs: number;`
   Single-word fields (`id`, `name`, `slug`, `status`) need no `name`; they are already snake_case.
3. **Timestamps**: always named:
   `@CreateDateColumn({ name: 'created_at' }) createdAt: Date;`
   `@UpdateDateColumn({ name: 'updated_at' }) updatedAt: Date;`
4. **Foreign keys**: keep a plain id column *and* the relation, both pointing at the same snake_case column:
   ```typescript
   @Column({ name: 'project_id' })
   projectId: string;

   @ManyToOne('Project', 'repos', { onDelete: 'CASCADE' })
   @JoinColumn({ name: 'project_id' })
   project?: Relation<Project>;
   ```
5. **Indexes**: decorators reference **property names**, not column names: `@Index(['projectId', 'status'])`. TypeORM maps them.
6. **Raw SQL and query builder strings** use the **column names**: `WHERE j.project_id = :projectId`, never `j."projectId"`.
7. **Query builder / find options with objects** use **property names**: `find({ where: { projectId } })`, `orderBy('j.queuedAt')` — TypeORM maps these.

## Example

```typescript
import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation, UpdateDateColumn } from 'typeorm';
import type { Job } from '../job/job.entity.js';

@Entity({ name: 'job_runs' })
@Index(['jobId', 'attempt'], { unique: true })
export class JobRun {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id' })
  jobId: string;

  @ManyToOne('Job', { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'job_id' })
  job?: Relation<Job>;

  @Column()
  attempt: number;

  @Column({ name: 'session_url', type: 'text', nullable: true })
  sessionUrl: string | null;

  @Column({ name: 'fired_at' })
  firedAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
```

## Checklist before finishing

- [ ] Table name is snake_case plural.
- [ ] Every multi-word column has `name: 'snake_case'`, including `created_at`, `updated_at` and every `*_id`.
- [ ] `@JoinColumn` uses the same snake_case name as the id column.
- [ ] Raw SQL strings use snake_case column names; object-based find options use camelCase properties.
- [ ] If the project already uses a naming strategy (e.g. `SnakeNamingStrategy` in the TypeORM config), follow it instead and do not add redundant `name` options; check the data source config first.
