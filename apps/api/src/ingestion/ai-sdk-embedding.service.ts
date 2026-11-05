import { createOpenAI } from '@ai-sdk/openai';
import { embedMany } from 'ai';
import { requireOpenAiApiKey, type AppConfig } from '../config/app-config.js';
import { EmbeddingError, validateEmbeddings, type EmbeddingService } from './embedding.service.js';

/** Texts per provider request. */
export const EMBEDDING_BATCH_SIZE = 96;

/** EmbeddingService on the Vercel AI SDK (`embedMany`) with the OpenAI provider. */
export class AiSdkEmbeddingService implements EmbeddingService {
  readonly model: string;
  readonly dimension: number;
  private readonly embeddingModel: Parameters<typeof embedMany>[0]['model'];

  constructor(config: Pick<AppConfig, 'openaiApiKey' | 'embeddingModel' | 'embeddingDimension'>) {
    const provider = createOpenAI({ apiKey: requireOpenAiApiKey(config) });
    this.model = config.embeddingModel;
    this.dimension = config.embeddingDimension;
    this.embeddingModel = provider.embedding(config.embeddingModel);
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const result: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = texts.slice(i, i + EMBEDDING_BATCH_SIZE);
      let embeddings: unknown;
      try {
        // Sequential batches keep ordering trivial and bound concurrent provider load.
        ({ embeddings } = await embedMany({
          model: this.embeddingModel,
          values: batch,
          dimensions: this.dimension,
          maxParallelCalls: 1,
        }));
      } catch {
        // The raw error may carry request data or secrets; surface a fixed message only.
        throw new EmbeddingError('provider_failed', 'Embedding provider request failed');
      }
      result.push(...validateEmbeddings(embeddings, batch.length, this.dimension));
    }
    return result;
  }
}
