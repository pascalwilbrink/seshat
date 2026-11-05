import { Inject, Injectable, type Provider, type Type } from '@nestjs/common';
import { FILE_INGESTORS, type FileIngestor } from './file-ingestor.js';
import { UnsupportedFileTypeError } from './ingestion-errors.js';

/** Selects the ingestor for an extension from the injected list only. Never edited to add a file type. */
@Injectable()
export class FileIngestorProvider {
  private readonly byExtension = new Map<string, FileIngestor>();

  constructor(@Inject(FILE_INGESTORS) ingestors: FileIngestor[]) {
    for (const ingestor of ingestors) {
      for (const ext of ingestor.extensions) {
        const key = normalize(ext);
        if (this.byExtension.has(key)) throw new Error(`Extension .${key} is registered by more than one ingestor`);
        this.byExtension.set(key, ingestor);
      }
    }
  }

  supports(extension: string): boolean {
    return this.byExtension.has(normalize(extension));
  }

  /** Throws `UnsupportedFileTypeError` (permanent) when no registered ingestor handles the extension. */
  get(extension: string): FileIngestor {
    const ingestor = this.byExtension.get(normalize(extension));
    if (!ingestor) throw new UnsupportedFileTypeError(normalize(extension));
    return ingestor;
  }
}

function normalize(extension: string): string {
  return extension.replace(/^\./, '').toLowerCase();
}

/**
 * Multi-registration: lists the ingestor classes of a module and aggregates their instances under `FILE_INGESTORS`.
 * Add an ingestor by adding its class to the list; `FileIngestorProvider` stays unchanged.
 * Spread the result into the `providers` of the module that owns `FileIngestorProvider`.
 */
export function provideFileIngestors(...ingestors: Type<FileIngestor>[]): Provider[] {
  return [
    ...ingestors,
    { provide: FILE_INGESTORS, useFactory: (...instances: FileIngestor[]) => instances, inject: ingestors },
    FileIngestorProvider,
  ];
}
