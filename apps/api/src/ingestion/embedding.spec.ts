import { beforeEach, describe, expect, it, vi } from 'vitest';

const embedMany = vi.fn();
const embedding = vi.fn((id: string) => ({ modelId: id }));
const createOpenAI = vi.fn((_opts: unknown) => ({ embedding }));
vi.mock('ai', () => ({ embedMany: (a: unknown) => embedMany(a) }));
vi.mock('@ai-sdk/openai', () => ({ createOpenAI: (o: unknown) => createOpenAI(o) }));

const { AiSdkEmbeddingService, EMBEDDING_BATCH_SIZE } = await import('./ai-sdk-embedding.service.js');
const { EmbeddingError, validateEmbeddings } = await import('./embedding.service.js');
const { FakeEmbeddingService } = await import('./fake-embedding.service.js');
const { ConfigError } = await import('../config/app-config.js');

const SENTINEL_KEY = 'sk-sentinel-key-123';
const SENTINEL_TEXT = 'sentinel-document-content';
const cfg = { openaiApiKey: SENTINEL_KEY, embeddingModel: 'text-embedding-3-small', embeddingDimension: 3 };

function echoVectors(args: { values: string[] }) {
  return Promise.resolve({ embeddings: args.values.map((v) => [Number(v), 0, 1]) });
}

describe('AiSdkEmbeddingService', () => {
  beforeEach(() => {
    embedMany.mockReset();
    embedding.mockClear();
    createOpenAI.mockClear();
  });

  it('configures the OpenAI provider with the key, model and dimension', async () => {
    embedMany.mockImplementation(echoVectors);
    const service = new AiSdkEmbeddingService(cfg);
    expect(createOpenAI).toHaveBeenCalledWith({ apiKey: SENTINEL_KEY });
    expect(embedding).toHaveBeenCalledWith('text-embedding-3-small');
    expect(service.model).toBe('text-embedding-3-small');
    expect(service.dimension).toBe(3);
    await service.embed(['1']);
    expect(embedMany).toHaveBeenCalledWith(expect.objectContaining({ dimensions: 3, values: ['1'] }));
  });

  it('refuses to be built without an API key, without naming a value', () => {
    expect(() => new AiSdkEmbeddingService({ ...cfg, openaiApiKey: undefined })).toThrow(ConfigError);
  });

  it('returns [] for empty input without calling the provider', async () => {
    const service = new AiSdkEmbeddingService(cfg);
    expect(await service.embed([])).toEqual([]);
    expect(embedMany).not.toHaveBeenCalled();
  });

  it('batches and preserves order', async () => {
    embedMany.mockImplementation(echoVectors);
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE * 2 + 5 }, (_, i) => String(i));
    const out = await new AiSdkEmbeddingService(cfg).embed(texts);
    expect(embedMany).toHaveBeenCalledTimes(3);
    expect(embedMany.mock.calls.map((c) => c[0].values.length)).toEqual([EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_SIZE, 5]);
    expect(out.map((v) => v[0])).toEqual(texts.map(Number));
  });

  it.each([
    ['too few vectors', [[0, 0, 0]]],
    ['wrong dimension', [[0, 0], [0, 0]]],
    ['NaN', [[0, 0, 0], [0, Number.NaN, 0]]],
    ['Infinity', [[0, 0, 0], [0, Number.POSITIVE_INFINITY, 0]]],
    ['non-array', 'nope'],
  ])('rejects malformed output: %s', async (_name, embeddings) => {
    embedMany.mockResolvedValue({ embeddings });
    await expect(new AiSdkEmbeddingService(cfg).embed(['a', 'b'])).rejects.toMatchObject({ code: 'invalid_output' });
  });

  it('exposes no texts, vectors, keys or raw provider errors on failure', async () => {
    embedMany.mockRejectedValue(new Error(`401 for key ${SENTINEL_KEY} input ${SENTINEL_TEXT}`));
    const err = await new AiSdkEmbeddingService(cfg).embed([SENTINEL_TEXT]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    const shown = `${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`;
    expect(shown).not.toContain(SENTINEL_KEY);
    expect(shown).not.toContain(SENTINEL_TEXT);
    expect((err as { cause?: unknown }).cause).toBeUndefined();

    embedMany.mockResolvedValue({ embeddings: [[0.123456, Number.NaN, 0]] });
    const bad = await new AiSdkEmbeddingService(cfg).embed([SENTINEL_TEXT]).catch((e: unknown) => e);
    expect(`${(bad as Error).message}`).not.toMatch(/0\.123456|sentinel/);
  });
});

describe('validateEmbeddings', () => {
  it('accepts valid output', () => {
    expect(validateEmbeddings([[1, 2]], 1, 2)).toEqual([[1, 2]]);
  });
});

describe('FakeEmbeddingService', () => {
  it('is deterministic, ordered, unit length and of the requested dimension', async () => {
    const fake = new FakeEmbeddingService(1536);
    const [a1, b] = await fake.embed(['a', 'b']);
    const [a2] = await fake.embed(['a']);
    expect(a1).toEqual(a2);
    expect(a1).not.toEqual(b);
    expect(a1).toHaveLength(1536);
    expect(Math.hypot(...a1!)).toBeCloseTo(1);
    expect(await fake.embed([])).toEqual([]);
  });
});
