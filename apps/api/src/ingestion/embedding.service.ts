/** Injection token for the EmbeddingService (explicit, since Vitest emits no decorator metadata). */
export const EMBEDDING_SERVICE = Symbol('EMBEDDING_SERVICE');

/** Turns texts into vectors. Domain code depends on this interface only, never on a provider SDK. */
export interface EmbeddingService {
  /** Embedding model name, stored with every chunk. */
  readonly model: string;
  /** Length of every returned vector. */
  readonly dimension: number;
  /**
   * Embeds texts. The result has exactly one vector per input, in input order, each of length `dimension` with finite
   * coordinates. An empty input returns an empty array without calling the provider.
   */
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * Failure of an embedding call. The message is a fixed safe string: it never contains input texts, vectors, API keys
 * or the provider's raw error text.
 */
export class EmbeddingError extends Error {
  constructor(
    readonly code: 'provider_failed' | 'invalid_output',
    message: string,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** Checks count, dimension and finiteness of provider output before anything is persisted. */
export function validateEmbeddings(embeddings: unknown, count: number, dimension: number): number[][] {
  if (!Array.isArray(embeddings) || embeddings.length !== count) {
    throw new EmbeddingError('invalid_output', 'Embedding provider returned an unexpected number of vectors');
  }
  for (const vector of embeddings) {
    if (!Array.isArray(vector) || vector.length !== dimension) {
      throw new EmbeddingError('invalid_output', 'Embedding provider returned a vector of the wrong dimension');
    }
    for (const x of vector) {
      if (typeof x !== 'number' || !Number.isFinite(x)) {
        throw new EmbeddingError('invalid_output', 'Embedding provider returned a non-finite vector coordinate');
      }
    }
  }
  return embeddings as number[][];
}
