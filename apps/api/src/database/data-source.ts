import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { getAppConfig } from '../config/index.js';
import { createDataSourceOptions } from './options.js';

export { createDataSourceOptions };

/**
 * The one DataSource used by the Nest app and by the TypeORM CLI (migration:* scripts).
 * Creating it opens no connection; it is initialized by the app or the CLI.
 */
export const dataSource = new DataSource(createDataSourceOptions(getAppConfig()));
