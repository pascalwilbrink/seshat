import { describe, expect, it } from 'vitest';
import {
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  globalSearchRequestSchema,
  splitSearchFilters,
  toSearchRequest,
  workspaceSearchRequestSchema,
} from './search-request.dto.js';

const ID_A = '0B3D6F0E-6C2A-4A58-9F0E-3F1A2B3C4D5E';
const ID_B = '7c1d2e3f-0000-4000-8000-000000000001';
const ok = (body: unknown) => workspaceSearchRequestSchema.safeParse(body);
const bad = (body: unknown, path?: string) => {
  const r = workspaceSearchRequestSchema.safeParse(body);
  expect(r.success, JSON.stringify(body)).toBe(false);
  if (path && !r.success) expect(r.error.issues.map((i) => i.path.join('.'))).toContain(path);
};

describe('search request: defaults', () => {
  it('applies every default for a bare query', () => {
    const r = workspaceSearchRequestSchema.parse({ query: 'hello' });
    expect(r).toEqual({
      query: 'hello', types: ['files', 'memories'], tagMatch: 'any', includeSuperseded: false, limit: SEARCH_LIMIT_DEFAULT, includeGlobal: false,
    });
    expect(SEARCH_LIMIT_DEFAULT).toBe(10);
  });

  it('the Global request has no includeGlobal', () => {
    const r = globalSearchRequestSchema.parse({ query: 'hello' });
    expect(r).not.toHaveProperty('includeGlobal');
    expect(globalSearchRequestSchema.safeParse({ query: 'x', includeGlobal: false }).success).toBe(false);
    expect(toSearchRequest(r).includeGlobal).toBe(false);
  });
});

describe('search request: query', () => {
  it('trims and enforces 1-2000 characters (code points)', () => {
    expect(ok({ query: '  a  ' }).data?.query).toBe('a');
    expect(ok({ query: 'x'.repeat(2000) }).success).toBe(true);
    bad({ query: 'x'.repeat(2001) }, 'query');
    expect(ok({ query: '😀'.repeat(2000) }).success).toBe(true);
    bad({ query: '😀'.repeat(2001) }, 'query');
    bad({ query: '' }, 'query');
    bad({ query: '   \n\t ' }, 'query');
    bad({}, 'query');
    bad({ query: 5 }, 'query');
    bad({ query: null }, 'query');
  });
});

describe('search request: types', () => {
  it('accepts either or both, deduplicated', () => {
    expect(ok({ query: 'q', types: ['files'] }).data?.types).toEqual(['files']);
    expect(ok({ query: 'q', types: ['memories'] }).data?.types).toEqual(['memories']);
    expect(ok({ query: 'q', types: ['memories', 'files', 'memories'] }).data?.types).toEqual(['memories', 'files']);
  });
  it('rejects empty, unknown and non-array', () => {
    bad({ query: 'q', types: [] }, 'types');
    bad({ query: 'q', types: ['chunks'] });
    bad({ query: 'q', types: 'files' }, 'types');
    bad({ query: 'q', types: null }, 'types');
  });
});

describe('search request: includeGlobal', () => {
  it('is a strict boolean on the Workspace request', () => {
    expect(ok({ query: 'q', includeGlobal: true }).data?.includeGlobal).toBe(true);
    bad({ query: 'q', includeGlobal: 'true' }, 'includeGlobal');
    bad({ query: 'q', includeGlobal: 1 }, 'includeGlobal');
  });
});

describe('search request: id filters', () => {
  it('accepts UUIDs, lowercases and deduplicates', () => {
    const r = ok({ query: 'q', collectionIds: [ID_A, ID_A.toLowerCase(), ID_B], fileIds: [ID_B] }).data!;
    expect(r.collectionIds).toEqual([ID_A.toLowerCase(), ID_B]);
    expect(r.fileIds).toEqual([ID_B]);
  });
  it.each(['collectionIds', 'fileIds'])('rejects malformed, empty and oversized %s', (field) => {
    bad({ query: 'q', [field]: ['not-a-uuid'] }, `${field}.0`);
    bad({ query: 'q', [field]: [''] });
    bad({ query: 'q', [field]: [5] });
    bad({ query: 'q', [field]: [] }, field);
    bad({ query: 'q', [field]: ID_B }, field);
    bad({ query: 'q', [field]: null }, field);
    bad({ query: 'q', [field]: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, field);
    expect(ok({ query: 'q', [field]: Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }).success).toBe(true);
  });
});

describe('search request: tags and tagMatch', () => {
  it('normalizes and deduplicates tags', () => {
    expect(ok({ query: 'q', tags: [' Alpha ', 'alpha', 'beta:1'] }).data?.tags).toEqual(['alpha', 'beta:1']);
  });
  it('rejects invalid tags, empty lists and non-strings', () => {
    bad({ query: 'q', tags: ['bad tag!'] });
    bad({ query: 'q', tags: [''] });
    bad({ query: 'q', tags: ['x'.repeat(51)] });
    bad({ query: 'q', tags: [] }, 'tags');
    bad({ query: 'q', tags: [1] });
    bad({ query: 'q', tags: 'a' }, 'tags');
  });
  it('tagMatch is any (default) or all', () => {
    expect(ok({ query: 'q', tagMatch: 'all' }).data?.tagMatch).toBe('all');
    bad({ query: 'q', tagMatch: 'some' }, 'tagMatch');
    bad({ query: 'q', tagMatch: 'ALL' }, 'tagMatch');
  });
});

describe('search request: memoryTypes and includeSuperseded', () => {
  it('accepts the six Memory types', () => {
    const all = ['fact', 'decision', 'preference', 'experience', 'procedure', 'context'];
    expect(ok({ query: 'q', memoryTypes: all }).data?.memoryTypes).toEqual(all);
    expect(ok({ query: 'q', memoryTypes: ['fact', 'fact'] }).data?.memoryTypes).toEqual(['fact']);
  });
  it('rejects unknown and empty', () => {
    bad({ query: 'q', memoryTypes: ['note'] });
    bad({ query: 'q', memoryTypes: [] }, 'memoryTypes');
    bad({ query: 'q', memoryTypes: 'fact' }, 'memoryTypes');
  });
  it('includeSuperseded is a strict boolean', () => {
    expect(ok({ query: 'q', includeSuperseded: true }).data?.includeSuperseded).toBe(true);
    bad({ query: 'q', includeSuperseded: 'yes' }, 'includeSuperseded');
  });
});

describe('search request: limit and minScore', () => {
  it('limit is an integer 1-50', () => {
    expect(ok({ query: 'q', limit: 1 }).data?.limit).toBe(1);
    expect(ok({ query: 'q', limit: SEARCH_LIMIT_MAX }).data?.limit).toBe(50);
    for (const limit of [0, -1, 51, 1.5, '10', null, Number.NaN, Infinity]) bad({ query: 'q', limit }, 'limit');
  });
  it('minScore is an optional finite number', () => {
    expect(ok({ query: 'q' }).data).not.toHaveProperty('minScore');
    expect(ok({ query: 'q', minScore: 0 }).data?.minScore).toBe(0);
    expect(ok({ query: 'q', minScore: 0.0164 }).data?.minScore).toBe(0.0164);
    for (const minScore of [Number.NaN, Infinity, -Infinity, '0.1', null, true]) bad({ query: 'q', minScore }, 'minScore');
  });
});

describe('search request: unknown fields', () => {
  it.each([
    { scope: 'global' }, { workspaceId: ID_B }, { offset: 1 }, { embedding: [1] }, { __proto__x: 1 }, { Query: 'x' },
  ])('rejects %j', (extra) => {
    const r = workspaceSearchRequestSchema.safeParse({ query: 'q', ...extra });
    expect(r.success).toBe(false);
  });
  it('rejects non-objects without throwing', () => {
    for (const body of [null, 'q', 5, [], undefined]) expect(workspaceSearchRequestSchema.safeParse(body).success).toBe(false);
  });
  it('error issues never echo submitted values', () => {
    const r = workspaceSearchRequestSchema.safeParse({ query: 'q', collectionIds: ['SENTINEL-secret'] });
    expect(JSON.stringify(r.error?.issues.map((i) => ({ p: i.path, m: i.message })))).not.toContain('SENTINEL');
  });
});

describe('type-specific filter semantics', () => {
  it('collection/file filters constrain chunks, memory type/superseded constrain memories, tags constrain both', () => {
    const req = workspaceSearchRequestSchema.parse({
      query: 'q', collectionIds: [ID_B], fileIds: [ID_A], tags: ['x'], tagMatch: 'all', memoryTypes: ['fact'], includeSuperseded: true,
    });
    const f = splitSearchFilters(req);
    expect(f.chunk).toEqual({ collectionIds: [ID_B], fileIds: [ID_A.toLowerCase()], tags: ['x'], tagMatch: 'all' });
    expect(f.memory).toEqual({ types: ['fact'], includeSuperseded: true, tags: ['x'], tagMatch: 'all' });
  });
  it('absent filters are null (no narrowing) and Memory filters carry no chunk fields', () => {
    const f = splitSearchFilters(workspaceSearchRequestSchema.parse({ query: 'q' }));
    expect(f.chunk).toEqual({ collectionIds: null, fileIds: null, tags: null, tagMatch: 'any' });
    expect(f.memory).toEqual({ types: null, includeSuperseded: false, tags: null, tagMatch: 'any' });
    expect(f.memory).not.toHaveProperty('collectionIds');
    expect(f.chunk).not.toHaveProperty('types');
  });
});
