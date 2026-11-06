import type { DataSource } from 'typeorm';

/**
 * Migration helpers for reversibility tests. They work from migration names instead of positions, so adding a new
 * migration never breaks the tests of older ones (a test only names its own migration).
 *
 * All helpers assume every migration known to the data source is currently applied.
 */

/** Names of all migrations known to the data source, in the order they are applied. */
export function migrationNames(ds: DataSource): string[] {
  return ds.migrations.map((m) => m.constructor.name);
}

/** Names from `name` (inclusive) to the newest migration, in apply order. Throws for an unknown name. */
export function migrationsFrom(ds: DataSource, name: string): string[] {
  const all = migrationNames(ds);
  const index = all.indexOf(name);
  if (index < 0) throw new Error(`Unknown migration ${name}`);
  return all.slice(index);
}

/** Names of the migrations applied after `name`, in apply order. */
export function migrationsAfter(ds: DataSource, name: string): string[] {
  return migrationsFrom(ds, name).slice(1);
}

async function undo(ds: DataSource, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await ds.undoLastMigration({ transaction: 'each' });
}

/** Reverts `name` and every migration applied after it, newest first. */
export async function revertThrough(ds: DataSource, name: string): Promise<void> {
  await undo(ds, migrationsFrom(ds, name).length);
}

/** Reverts every migration applied after `name`, newest first, leaving `name` applied. */
export async function revertAfter(ds: DataSource, name: string): Promise<void> {
  await undo(ds, migrationsAfter(ds, name).length);
}
