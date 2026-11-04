import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FILE_DELETED_EVENT, type FileDeletedEvent } from '../files/file.events.js';
import { StorageCleanupService } from './storage-cleanup.service.js';

/** After a file deletion committed, removes that file's stored original from the persisted ledger. */
@Injectable()
export class StorageCleanupListener {
  private readonly logger = new Logger('StorageCleanup');

  constructor(@Inject(StorageCleanupService) private readonly cleanup: StorageCleanupService) {}

  @OnEvent(FILE_DELETED_EVENT)
  async onFileDeleted(event: FileDeletedEvent): Promise<void> {
    try {
      await this.cleanup.drain({ resourceId: event.id });
    } catch (err) {
      this.logger.error(`file.deleted cleanup failed for file ${event.id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }
}
