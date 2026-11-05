import { describe, expect, it } from 'vitest';
import { createMemorySchema, toMemoryDto, updateMemorySchema } from './memory.dto.js';
import type { Memory } from './memory.entity.js';

const UUID = '3f2a6b1c-5d4e-4f60-8a7b-9c0d1e2f3a4b';
const full = { type: 'fact', content: 'hello', title: null, metadata: null, confidence: null, source: null, tags: [] };
const issuePaths = (r: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  r.error?.issues.map((i) => i.path.join('.')) ?? [];

describe('createMemorySchema', () => {
  it('accepts the minimum and normalizes tags', () => {
    const r = createMemorySchema.parse({ type: 'decision', content: 'x', tags: [' Alpha ', 'alpha', 'b/c'] });
    expect(r.tags).toEqual(['alpha', 'b/c']);
  });
  it('accepts every type and rejects others', () => {
    for (const t of ['fact', 'decision', 'preference', 'experience', 'procedure', 'context']) {
      expect(createMemorySchema.safeParse({ type: t, content: 'x' }).success).toBe(true);
    }
    expect(createMemorySchema.safeParse({ type: 'note', content: 'x' }).success).toBe(false);
  });
  it('bounds content in characters', () => {
    const ok = (c: string) => createMemorySchema.safeParse({ type: 'fact', content: c }).success;
    expect(ok('')).toBe(false);
    expect(ok('   \n ')).toBe(false);
    expect(ok('a'.repeat(10000))).toBe(true);
    expect(ok('a'.repeat(10001))).toBe(false);
    expect(ok('😀'.repeat(10000))).toBe(true); // code points, like char_length
    expect(ok('😀'.repeat(10001))).toBe(false);
  });
  it('bounds title and source', () => {
    const ok = (extra: object) => createMemorySchema.safeParse({ type: 'fact', content: 'x', ...extra }).success;
    expect(ok({ title: 'a'.repeat(200) })).toBe(true);
    expect(ok({ title: 'a'.repeat(201) })).toBe(false);
    expect(ok({ source: 'a'.repeat(500) })).toBe(true);
    expect(ok({ source: 'a'.repeat(501) })).toBe(false);
  });
  it('bounds confidence to 0..1', () => {
    const ok = (confidence: unknown) => createMemorySchema.safeParse({ type: 'fact', content: 'x', confidence }).success;
    expect([0, 0.5, 1, null].every(ok)).toBe(true);
    expect([-0.01, 1.01, '0.5', Number.NaN, Infinity].some(ok)).toBe(false);
  });
  it('requires metadata to be a JSON object within 8 KB of UTF-8', () => {
    const ok = (metadata: unknown) => createMemorySchema.safeParse({ type: 'fact', content: 'x', metadata }).success;
    expect(ok({ a: [1, { b: null }] })).toBe(true);
    expect(ok([])).toBe(false);
    expect(ok('str')).toBe(false);
    expect(ok(5)).toBe(false);
    const overhead = JSON.stringify({ k: '' }).length;
    expect(ok({ k: 'a'.repeat(8192 - overhead) })).toBe(true);
    expect(ok({ k: 'a'.repeat(8192 - overhead + 1) })).toBe(false);
    // 3 bytes per character: 3000 characters is 9000 bytes although fewer than 8192 characters.
    expect(ok({ k: '€'.repeat(3000) })).toBe(false);
  });
  it('validates tags and supersedes', () => {
    const ok = (extra: object) => createMemorySchema.safeParse({ type: 'fact', content: 'x', ...extra }).success;
    expect(ok({ tags: ['bad tag'] })).toBe(false);
    expect(ok({ tags: [''] })).toBe(false);
    expect(ok({ tags: [1] })).toBe(false);
    expect(ok({ tags: Array.from({ length: 101 }, (_, i) => `t${i}`) })).toBe(false);
    expect(ok({ supersedes: UUID })).toBe(true);
    expect(ok({ supersedes: null })).toBe(true);
    expect(ok({ supersedes: 'nope' })).toBe(false);
  });
  it.each([
    'createdByKind',
    'createdByKeyId',
    'createdByKeyName',
    'clientName',
    'clientVersion',
    'client',
    'provenance',
    'createdBy',
    'status',
    'supersededBy',
    'contentHash',
    'embedding',
    'embeddingStatus',
    'scope',
    'workspaceId',
    'id',
  ])('rejects the server-owned field %s', (field) => {
    const r = createMemorySchema.safeParse({ type: 'fact', content: 'x', [field]: 'forged' });
    expect(r.success).toBe(false);
  });
  it('rejects forged nested provenance', () => {
    const r = createMemorySchema.safeParse({ type: 'fact', content: 'x', provenance: { createdBy: { keyId: UUID } } });
    expect(r.success).toBe(false);
  });
});

describe('updateMemorySchema (full replacement)', () => {
  it('accepts a complete body with explicit nulls', () => {
    expect(updateMemorySchema.safeParse(full).success).toBe(true);
  });
  it.each(['type', 'content', 'title', 'metadata', 'confidence', 'source', 'tags'])('requires %s', (field) => {
    const body: Record<string, unknown> = { ...full };
    delete body[field];
    const r = updateMemorySchema.safeParse(body);
    expect(r.success).toBe(false);
    expect(issuePaths(r)).toContain(field);
  });
  it('does not accept null for required fields', () => {
    expect(updateMemorySchema.safeParse({ ...full, content: null }).success).toBe(false);
    expect(updateMemorySchema.safeParse({ ...full, type: null }).success).toBe(false);
    expect(updateMemorySchema.safeParse({ ...full, tags: null }).success).toBe(false);
  });
  it.each(['supersedes', 'status', 'supersededBy', 'contentHash', 'embedding', 'scope', 'createdByKind', 'createdByKeyName', 'clientName', 'provenance'])(
    'rejects %s',
    (field) => {
      expect(updateMemorySchema.safeParse({ ...full, [field]: 'x' }).success).toBe(false);
    },
  );
  it('applies the same bounds as create', () => {
    expect(updateMemorySchema.safeParse({ ...full, content: 'a'.repeat(10001) }).success).toBe(false);
    expect(updateMemorySchema.safeParse({ ...full, confidence: 2 }).success).toBe(false);
    expect(updateMemorySchema.safeParse({ ...full, metadata: [] }).success).toBe(false);
  });
});

describe('toMemoryDto', () => {
  const entity = {
    id: UUID,
    scope: 'workspace',
    workspaceId: UUID,
    scopeKey: UUID,
    type: 'fact',
    content: 'c',
    title: null,
    metadata: null,
    confidence: 0.5,
    source: null,
    status: 'superseded',
    supersededBy: UUID,
    createdByKind: 'api_key',
    createdByKeyId: UUID,
    createdByKeyName: 'ci',
    clientName: 'cursor',
    clientVersion: '1.2',
    contentHash: 'h'.repeat(64),
    embedding: [0.1, 0.2],
    embeddingModel: 'm',
    embeddingStatus: 'ready',
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
  } as unknown as Memory;

  it('exposes provenance and successor but no vectors, hash or key secrets', () => {
    const dto = toMemoryDto(entity, ['a']);
    expect(dto.provenance).toEqual({
      createdBy: { kind: 'api_key', keyId: UUID, keyName: 'ci' },
      client: { name: 'cursor', version: '1.2' },
    });
    expect(dto.supersededBy).toBe(UUID);
    const json = JSON.stringify(dto);
    for (const banned of ['embedding"', 'contentHash', 'scopeKey', 'hhhh', '0.1']) expect(json).not.toContain(banned);
    expect(Object.keys(dto).sort()).toEqual(
      [
        'id', 'scope', 'workspaceId', 'type', 'content', 'title', 'metadata', 'confidence', 'source', 'tags', 'status',
        'supersededBy', 'provenance', 'embeddingStatus', 'embeddingModel', 'createdAt', 'updatedAt',
      ].sort(),
    );
  });
  it('has no client for admin-created memories', () => {
    const dto = toMemoryDto({ ...entity, createdByKind: 'admin', createdByKeyId: null, createdByKeyName: null, clientName: null, clientVersion: null } as Memory, []);
    expect(dto.provenance).toEqual({ createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null });
  });
});
