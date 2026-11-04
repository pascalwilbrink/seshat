import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { Transform, type Readable } from 'node:stream';
import { BadRequestException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import Busboy from 'busboy';

export interface ReceivedUpload {
  /** Client-declared file name and MIME type: untrusted, sanitized by the caller. */
  filename: string;
  mimeType: string;
  /** Exact byte count and SHA-256 (hex) of what was streamed into storage. */
  size: number;
  sha256: string;
  collectionId: string | undefined;
  tags: string[];
}

export interface UploadReaderOptions {
  maxBytes: number;
  /** Stores the (already measured) stream; resolves once the object is durable. */
  store(stream: Readable): Promise<unknown>;
}

const invalid = () => new BadRequestException('Invalid request');
const tooLarge = () => new PayloadTooLargeException('Payload too large');
const MIN_DRAIN_BYTES = 1024 * 1024;

/**
 * Streams one multipart upload (`file` part, optional `collectionId` and repeated `tags` fields) into `store` without
 * buffering the original. The limit is enforced on the bytes actually read, never on Content-Length. On any failure the
 * returned promise rejects only after the storage write has settled (so no temporary object is left behind), and the
 * rest of the request is drained (bounded) so the client can read the error response.
 */
export function receiveUpload(req: IncomingMessage, opts: UploadReaderOptions): Promise<ReceivedUpload> {
  return new Promise<ReceivedUpload>((resolve, reject) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        // +1 so that exceeding the limit is observable by the meter below; busboy only bounds memory/time.
        limits: { fileSize: opts.maxBytes + 1, files: 1, fields: 33, parts: 34, fieldSize: 16 * 1024, fieldNameSize: 100 },
      });
    } catch {
      reject(invalid());
      return;
    }

    let failure: Error | undefined;
    let settled = false;
    let fileStream: Readable | undefined;
    let meter: Transform | undefined;
    let putDone: Promise<unknown> = Promise.resolve();
    let filename = '';
    let mimeType = '';
    let size = 0;
    let digest = '';
    let collectionId: string | undefined;
    const tags: string[] = [];

    const drain = () => {
      req.unpipe(bb);
      let drained = 0;
      const cap = Math.max(opts.maxBytes, MIN_DRAIN_BYTES);
      req.on('data', (chunk: Buffer) => {
        drained += chunk.length;
        if (drained > cap) req.destroy();
      });
      req.on('error', () => undefined);
      req.resume();
    };

    const settleFailure = () => {
      if (settled) return;
      settled = true;
      void putDone.then(
        () => reject(failure),
        () => reject(failure),
      );
    };

    // Records the first failure, stops the file stream and settles once storage has let go.
    const fail = (err: Error) => {
      if (failure) return;
      failure = err;
      fileStream?.unpipe();
      fileStream?.resume();
      meter?.destroy(err);
      drain();
      settleFailure();
    };

    bb.on('field', (name, value, info) => {
      if (failure) return;
      if (info.nameTruncated || info.valueTruncated) return fail(invalid());
      if (name === 'tags') tags.push(value);
      else if (name === 'collectionId' && collectionId === undefined) collectionId = value;
      else fail(invalid());
    });

    bb.on('file', (name, stream, info) => {
      if (failure) {
        stream.resume();
        return;
      }
      if (name !== 'file' || fileStream) {
        stream.resume();
        return fail(invalid());
      }
      fileStream = stream;
      filename = info.filename ?? '';
      mimeType = info.mimeType;
      const hash = createHash('sha256');
      meter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > opts.maxBytes) return cb(tooLarge());
          hash.update(chunk);
          cb(null, chunk);
        },
        flush(cb) {
          digest = hash.digest('hex');
          cb();
        },
      });
      // Storage attaches its own handlers later (after key resolution); an early failure must not be an unhandled event.
      meter.on('error', () => undefined);
      stream.on('limit', () => fail(tooLarge()));
      stream.on('error', (e) => fail(e instanceof HttpException ? e : invalid()));
      stream.pipe(meter);
      putDone = opts.store(meter);
      putDone.catch((e: Error) => fail(e));
    });

    bb.on('filesLimit', () => fail(invalid()));
    bb.on('fieldsLimit', () => fail(invalid()));
    bb.on('partsLimit', () => fail(invalid()));
    bb.on('error', () => fail(invalid()));

    bb.on('close', () => {
      if (failure || settled) return;
      if (!fileStream) return fail(invalid());
      settled = true;
      putDone.then(
        () => (failure ? reject(failure) : resolve({ filename, mimeType, size, sha256: digest, collectionId, tags })),
        (e: Error) => reject(failure ?? e),
      );
    });

    // A client that disconnects mid-upload never completes the request.
    req.on('close', () => {
      if (!req.complete) fail(invalid());
    });
    req.on('error', () => fail(invalid()));
    req.pipe(bb);
  });
}
