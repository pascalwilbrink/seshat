import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { FILE_STORAGE } from './file-storage.js';
import { LocalVolumeFileStorage } from './local-volume-file-storage.js';

/** Provides FILE_STORAGE. Startup fails (sanitized ConfigError) when FILE_STORAGE_DIR is missing or unusable. */
@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => LocalVolumeFileStorage.open(config.fileStorageDir),
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
