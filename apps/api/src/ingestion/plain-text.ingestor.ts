import { Injectable } from '@nestjs/common';
import type { Document } from './document.js';
import type { FileIngestor, IngestInput } from './file-ingestor.js';
import { InvalidEncodingError } from './ingestion-errors.js';

/** UTF-8 text for `txt` and `md`. Invalid bytes fail (fatal decoding); text, BOM and newlines are kept as they are. */
@Injectable()
export class PlainTextIngestor implements FileIngestor {
  readonly extensions = ['txt', 'md'] as const;

  async ingest(input: IngestInput): Promise<Document[]> {
    const chunks: Buffer[] = [];
    for await (const part of input.stream) chunks.push(Buffer.isBuffer(part) ? part : Buffer.from(part));
    let content: string;
    try {
      // ignoreBOM keeps U+FEFF in the output so offsets match the original text.
      content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
    } catch {
      throw new InvalidEncodingError();
    }
    if (content.length === 0) return [];
    return [
      {
        content,
        source: { fileId: input.fileId, fileName: input.fileName, extension: input.extension },
        startOffset: 0,
        startLine: 1,
      },
    ];
  }
}
