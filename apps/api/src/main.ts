import 'reflect-metadata';
import { createApp } from './app.setup.js';
import { AppModule } from './app.module.js';
import { DatabaseBootstrapError } from './database/bootstrap.js';
import { getAppConfig, loadConfigOrExit } from './config/index.js';

async function bootstrap() {
  const config = loadConfigOrExit(getAppConfig, {
    error: (message) => console.error(message),
    exit: (code) => process.exit(code),
  });
  const app = await createApp(AppModule, config);
  await app.listen(config.port);
}

bootstrap().catch((err: unknown) => {
  // Bootstrap errors are sanitized where they are raised; anything else is not printed raw.
  console.error(err instanceof DatabaseBootstrapError ? err.message : 'Application failed to start');
  process.exit(1);
});
