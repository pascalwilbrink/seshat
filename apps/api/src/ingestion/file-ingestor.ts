import type { Readable } from 'node:stream';
import type { Document } from './document.js';

/** What an ingestor receives: identity plus the original bytes, streamed from `FileStorage.get`. */
export interface IngestInput {
  fileId: string;
  fileName: string;
  /** Lowercase extension without the dot. */
  extension: string;
  stream: Readable;
}

/** Turns the original bytes of one supported file type into Documents. */
export interface FileIngestor {
  /** Lowercase extensions without the dot that this ingestor handles. */
  readonly extensions: readonly string[];
  /** Throws `IngestionError` (permanent) for content that can never be ingested. Must not log content. */
  ingest(input: IngestInput): Promise<Document[]>;
}

/** Injection token for the aggregated list of registered ingestors (explicit: Vitest emits no decorator metadata). */
export const FILE_INGESTORS = Symbol('FILE_INGESTORS');

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 || dot === fileName.length - 1 ? '' : fileName.slice(dot + 1).toLowerCase();
}
