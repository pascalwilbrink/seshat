import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './app-config.js';

/** apps/api/.env, resolved from this file so source (src/) and compiled (dist/) runs agree. */
const ENV_FILE = fileURLToPath(new URL('../../.env', import.meta.url));

let cached: AppConfig | undefined;

/**
 * The only place the process environment is read. Loads apps/api/.env (variables
 * already set in the environment win), then validates. Throws ConfigError.
 * Used by the API, the CLI data source and main.ts so all see the same config.
 */
export function getAppConfig(): AppConfig {
  if (!cached) {
    if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);
    cached = loadConfig(process.env);
  }
  return cached;
}
