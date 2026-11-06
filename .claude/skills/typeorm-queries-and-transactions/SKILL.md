---
name: typeorm-queries-and-transactions
description: "Use when writing queries, transactions, entity changes or e2e tests with TypeORM on SQLite (local/tests) and Postgres (production): empty where lists, undefined in where, uuid reference columns, portable column types and migrations, overlapping transactions, and shared e2e databases."
managed-by: gildeboek@5cad8a5
---

# TypeORM on SQLite and Postgres: traps in queries, transactions and tests

Code that passes on SQLite can fail or misbehave on Postgres. Each rule below cost a real bug.

## 1. An empty `where` list means no filter

`find({ where: [] })` returns **every row**. When an OR list can be empty, return early.

```typescript
// wrong: ids = [] → the whole table
return this.repo.find({ where: ids.map((id) => ({ id })), take: 20 });
// right
if (ids.length === 0) return [];
return this.repo.find({ where: ids.map((id) => ({ id })), take: 20 });
```

## 2. `undefined` in a where condition throws; `null` is not `undefined`

TypeORM 1.x throws "Undefined value encountered in property … of a where condition". Only query when the value is set, and treat `null` (clear) and `undefined` (absent) deliberately.
Never set `invalidWhereValuesBehavior` to ignore: it turns a lookup into an unbounded one.

```typescript
// wrong: featureId undefined → throws (or, with "ignore", matches everything)
await this.repo.find({ where: { featureId } });
// right
if (featureId === undefined) return [];            // absent: nothing to look up
if (featureId === null) return this.repo.find({ where: { featureId: IsNull() } }); // cleared
return this.repo.find({ where: { featureId } });
```

## 3. Reference columns have the same type as the column they point to

uuid points to uuid. A varchar compared with a uuid works on SQLite and fails on Postgres: `operator does not exist: uuid = character varying`.

```typescript
// wrong: @Column({ name: 'job_id' }) jobId: string;   (varchar, points at a uuid id)
// right
@Column({ name: 'job_id', type: 'uuid' })
jobId: string;
```

## 4. Portable column types, generated migrations

- Use `simple-json` and `simple-enum`; never `jsonb`, `timestamptz` or other Postgres-only types.
- Every entity change needs a generated Postgres migration (the repo's `migration:generate` script). Postgres never synchronizes; SQLite may locally.
- Never edit an existing migration; add a new one.

```typescript
@Column({ type: 'jsonb' }) meta: Meta;        // wrong: fails on SQLite
@Column({ type: 'simple-json' }) meta: Meta;  // right
```

## 5. Transactions: SQLite has one connection, Postgres has many

- SQLite: overlapping transactions fail with "cannot start a transaction within a transaction". Serialize concurrent write paths there (e.g. a mutex/queue around the transaction).
- Postgres: protect read-modify-write with row locks (`setLock('pessimistic_write')`) or conditional writes (`UPDATE … WHERE status = :expected`, check the affected count).
- Pass the transaction's `EntityManager` to **every** read and write inside it, including validation of rows created earlier in the same transaction; the global repository does not see uncommitted rows (and on SQLite may block).

```typescript
await this.dataSource.transaction(async (manager) => {
  const job = await manager.getRepository(Job).findOneOrFail({ where: { id }, lock: { mode: 'pessimistic_write' } });
  await this.validate(job, manager);               // right: manager passed down
  await manager.getRepository(Job).save(job);      // wrong: this.jobRepo.save(job)
});
```

Note: `lock` is ignored/unsupported on SQLite; keep the code path working there and serialize instead.

## 6. e2e tests sharing one SQLite file

- Assert on **count differences** or unique scopes (a fresh project/slug per test), never on absolute totals.
- Never run two e2e runs at the same time against the same file.
- Set env vars (`DATABASE_PATH`, `JWT_SECRET`, …) **before** importing a module that reads them at import time.

```typescript
const before = (await list()).length;            // right
await create();
expect((await list()).length).toBe(before + 1);  // wrong: toBe(1)

process.env.DATABASE_PATH = tmpFile;             // right: first
const { AppModule } = await import('../src/app.module.js'); // then import
```

## Checklist

- [ ] No query can receive an empty where list or an `undefined` value.
- [ ] Reference columns match the referenced column's type.
- [ ] Only portable column types; migration generated, none edited.
- [ ] Transactions pass the manager down; concurrent writes are serialized (SQLite) or locked/conditional (Postgres).
- [ ] e2e assertions are relative; env set before imports.
