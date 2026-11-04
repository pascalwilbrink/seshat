import { ConfigError, type AppConfig } from './app-config.js';

export interface StartupIo {
  error(message: string): void;
  exit(code: number): never;
}

/** Loads config; on invalid configuration prints one sanitized line and exits with code 1. */
export function loadConfigOrExit(load: () => AppConfig, io: StartupIo): AppConfig {
  try {
    return load();
  } catch (err) {
    // Never print the raw error: only ConfigError messages are known to be value-free.
    io.error(err instanceof ConfigError ? err.message : 'Invalid configuration: could not load configuration');
    return io.exit(1);
  }
}
