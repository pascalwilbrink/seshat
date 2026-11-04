import { Column, Entity, PrimaryColumn } from 'typeorm';
import { ScopedEntity } from '../../src/scopes/scoped.entity.js';

/** Test-only adopter of ScopedEntity. Not under src/, so the app never discovers or migrates it. */
@Entity({ name: 'scoped_test_items' })
export class ScopedTestItem extends ScopedEntity {
  @PrimaryColumn({ name: 'id', type: 'uuid', default: () => 'gen_random_uuid()' })
  id!: string;

  @Column({ name: 'label', type: 'varchar', length: 50 })
  label!: string;
}
