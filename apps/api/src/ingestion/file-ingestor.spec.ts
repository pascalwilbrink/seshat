import { Injectable, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { Document } from './document.js';
import { extensionOf, type FileIngestor, type IngestInput } from './file-ingestor.js';
import { FileIngestorProvider, provideFileIngestors } from './file-ingestor.provider.js';
import { InvalidEncodingError, UnsupportedFileTypeError, isPermanentIngestionError } from './ingestion-errors.js';
import { PlainTextIngestor } from './plain-text.ingestor.js';

const input = (bytes: Buffer | string, fileName = 'a.txt'): IngestInput => ({
  fileId: 'f1',
  fileName,
  extension: extensionOf(fileName),
  stream: Readable.from([Buffer.from(bytes)]),
});

@Injectable()
class PagedTestIngestor implements FileIngestor {
  readonly extensions = ['PAGED'];
  async ingest(i: IngestInput): Promise<Document[]> {
    return [{ content: 'p2', source: { fileId: i.fileId, fileName: i.fileName, extension: i.extension }, startOffset: 10, startLine: 4, page: 2 }];
  }
}

async function provider(...extra: (new () => FileIngestor)[]) {
  @Module({ providers: provideFileIngestors(PlainTextIngestor, ...extra) })
  class TestModule {}
  const ctx = await NestFactory.createApplicationContext(TestModule, { logger: false, abortOnError: false });
  return ctx.get(FileIngestorProvider);
}

describe('FileIngestorProvider', () => {
  it('matches extensions case-insensitively', async () => {
    const p = await provider();
    for (const e of ['txt', 'TXT', '.Md', 'md']) expect(p.get(e)).toBeInstanceOf(PlainTextIngestor);
  });

  it('uses a newly registered ingestor without provider changes', async () => {
    const p = await provider(PagedTestIngestor);
    const docs = await p.get('paged').ingest(input('x', 'b.paged'));
    expect(docs[0]).toMatchObject({ page: 2, startOffset: 10, startLine: 4 });
    expect(p.get('txt')).toBeInstanceOf(PlainTextIngestor);
  });

  it('throws a typed permanent error with a safe message for unknown extensions', async () => {
    const p = await provider();
    let err: unknown;
    try { p.get('xyz'); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedFileTypeError);
    expect((err as Error).message).toBe('No ingestor for .xyz');
    expect(isPermanentIngestionError(err)).toBe(true);
    expect(() => p.get('')).toThrow('No ingestor for this file type');
  });

  it('rejects two ingestors for one extension', async () => {
    await expect(provider(class extends PlainTextIngestor {})).rejects.toThrow(/more than one/);
  });
});

describe('PlainTextIngestor', () => {
  const ing = new PlainTextIngestor();

  it('decodes valid multibyte UTF-8 with source metadata and keeps newlines and BOM', async () => {
    const text = '﻿hé 日本 😀\r\nline2\n';
    const [doc] = await ing.ingest(input(text, 'N.MD'));
    expect(doc).toEqual({
      content: text,
      source: { fileId: 'f1', fileName: 'N.MD', extension: 'md' },
      startOffset: 0,
      startLine: 1,
    });
  });

  it('returns no documents for empty input', async () => {
    expect(await ing.ingest(input(Buffer.alloc(0)))).toEqual([]);
  });

  it('fails invalid UTF-8 with a safe permanent error', async () => {
    const bad = Buffer.concat([Buffer.from('SECRET-SENTINEL '), Buffer.from([0xff, 0xfe])]);
    const err = await ing.ingest(input(bad)).catch((e) => e);
    expect(err).toBeInstanceOf(InvalidEncodingError);
    expect(err.message).toBe('File is not valid UTF-8 text');
    expect(err.message).not.toContain('SECRET');
    expect(err.permanent).toBe(true);
  });

  it('fails a truncated multibyte sequence', async () => {
    await expect(ing.ingest(input(Buffer.from([0xe6, 0x97])))).rejects.toBeInstanceOf(InvalidEncodingError);
  });
});
