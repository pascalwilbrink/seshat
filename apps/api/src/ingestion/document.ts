/**
 * Extracted text of (part of) an original file, with the position information later chunking needs.
 *
 * Offsets are UTF-16 code unit offsets (JavaScript string indexes) into the text of the ORIGINAL file as decoded by the
 * ingestor, half-open `[start, end)`. Text is never normalized (newlines, BOM and whitespace stay as they were), so a
 * chunk offset is always an exact slice of the original text. Lines are 1-based.
 */
export interface DocumentSource {
  fileId: string;
  fileName: string;
  /** Lowercase extension without the dot, '' when the name has none. */
  extension: string;
}

export interface Document {
  content: string;
  source: DocumentSource;
  /** Offset of `content[0]` in the original text. A single-document ingestor uses 0. */
  startOffset: number;
  /** 1-based line of `content[0]` in the original text. */
  startLine: number;
  /** Optional 1-based page, for ingestors of paginated formats. */
  page?: number;
  /** Optional free-form location label (for example a sheet or slide name) from future ingestors. */
  label?: string;
}
