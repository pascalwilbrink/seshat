import { createHash } from 'node:crypto';
import type { EmbeddingService } from './embedding.service.js';

/** Deterministic, network-free EmbeddingService for tests: the same text always gives the same unit-length vector. */
export class FakeEmbeddingService implements EmbeddingService {
  readonly calls: string[][] = [];

  constructor(
    readonly dimension = 1536,
    readonly model = 'fake-embedding',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.calls.push([...texts]);
    return texts.map((text) => this.vectorFor(text));
  }

  vectorFor(text: string): number[] {
    const values: number[] = [];
    for (let block = 0; values.length < this.dimension; block++) {
      const digest = createHash('sha256').update(`${block}:${text}`).digest();
      for (let i = 0; i + 1 < digest.length && values.length < this.dimension; i += 2) {
        values.push(digest.readUInt16BE(i) / 65535 - 0.5);
      }
    }
    const norm = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0)) || 1;
    return values.map((x) => x / norm);
  }
}
