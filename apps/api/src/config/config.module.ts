import { Global, Module } from '@nestjs/common';
import { APP_CONFIG } from './app-config.js';
import { getAppConfig } from './env.js';

@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => getAppConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
