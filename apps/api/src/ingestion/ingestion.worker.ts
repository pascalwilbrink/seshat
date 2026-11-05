import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { FILE_UPLOADED_EVENT, type FileUploadedEvent } from '../files/file.events.js';
import { INGEST_FILE_QUEUE, QueueService } from '../queue/index.js';
import { IngestionProcessor } from './ingestion.processor.js';

export const INGESTION_PROCESSOR = Symbol('INGESTION_PROCESSOR');

/**
 * Registers the real `ingest-file` worker before the queue starts consuming (QueueService starts in
 * `onApplicationBootstrap`, after every `onModuleInit`) and turns committed uploads into singleton jobs.
 */
@Injectable()
export class IngestionWorker implements OnModuleInit {
  private readonly logger = new Logger('Ingestion');

  constructor(
    @Inject(QueueService) private readonly queue: QueueService,
    @Inject(INGESTION_PROCESSOR) private readonly processor: IngestionProcessor,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.queue.registerWorker(INGEST_FILE_QUEUE, (context) => this.processor.process(context));
  }

  /** Post-commit listener: a failure is logged by id and class only; the upload stays committed (file stays pending). */
  @OnEvent(FILE_UPLOADED_EVENT)
  async onFileUploaded(event: FileUploadedEvent): Promise<void> {
    try {
      await this.queue.enqueue(event.id);
    } catch (err) {
      this.logger.error(`Could not enqueue ingestion for file ${event.id} (${err instanceof Error ? err.name : 'unknown'})`);
    }
  }
}
