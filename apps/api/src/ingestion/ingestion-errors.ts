export type IngestionErrorCode = 'unsupported_file_type' | 'invalid_encoding';

/**
 * Permanent ingestion failure: retrying cannot succeed. The message is a fixed safe string; it never contains file
 * contents, bytes or storage keys (only the file extension for unsupported types).
 */
export class IngestionError extends Error {
  readonly permanent = true as const;

  constructor(
    readonly code: IngestionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'IngestionError';
  }
}

export class UnsupportedFileTypeError extends IngestionError {
  constructor(extension: string) {
    super('unsupported_file_type', `No ingestor for ${safeExtensionLabel(extension)}`);
    this.name = 'UnsupportedFileTypeError';
  }
}

export class InvalidEncodingError extends IngestionError {
  constructor() {
    super('invalid_encoding', 'File is not valid UTF-8 text');
    this.name = 'InvalidEncodingError';
  }
}

/** ".xyz" for a plain short extension; anything else is not echoed. */
function safeExtensionLabel(extension: string): string {
  return /^[a-z0-9_+-]{1,16}$/.test(extension) ? `.${extension}` : 'this file type';
}

export function isPermanentIngestionError(error: unknown): error is IngestionError {
  return error instanceof IngestionError;
}
