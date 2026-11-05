import 'reflect-metadata';
import { createApp } from './app.setup.js';
import { AppModule } from './app.module.js';
import { DatabaseBootstrapError } from './database/bootstrap.js';
import { EmbeddingDimensionError } from './database/embedding-dimension-guard.js';
import { ConfigError, getAppConfig, loadConfigOrExit } from './config/index.js';
import { LocalVolumeFileStorage } from './storage/local-volume-file-storage.js';

async function bootstrap() {
  const config = loadConfigOrExit(getAppConfig, {
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });
  // Fail fast with one sanitized line when the storage directory is missing or not writable.
  try {
    await LocalVolumeFileStorage.open(config.fileStorageDir);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  const app = await createApp(AppModule, config);
  await app.listen(config.port);
}

bootstrap().catch((err: unknown) => {
  // Bootstrap errors are sanitized where they are raised; anything else is not printed raw.
  console.error(err instanceof DatabaseBootstrapError || err instanceof EmbeddingDimensionError || err instanceof ConfigError ? err.message : 'Application failed to start');
  process.exit(1);
});
