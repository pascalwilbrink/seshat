# Database

- `options.ts` builds the TypeORM options (`synchronize: false` always); `data-source.ts` exports the single `dataSource` used by both Nest (`database.module.ts`) and the CLI.
- Migrations live in `src/migrations/` and are discovered next to the running layout (`.ts` from source, `.js` from `dist/`), so they never run twice.
- Run from the workspace root (set `DATABASE_URL`, or use `apps/api/.env`):

```sh
pnpm --filter @seshat/api migration:run
pnpm --filter @seshat/api migration:revert
pnpm --filter @seshat/api migration:generate src/migrations/AddThing   # diffs entities against the database
pnpm --filter @seshat/api migration:create src/migrations/AddThing     # empty timestamped migration
```

- Startup runs pending migrations only when `DB_MIGRATE_ON_START` resolves to true.
- Integration tests: `TEST_DATABASE_URL=postgres://… pnpm test` against a disposable database whose name contains `test`.
