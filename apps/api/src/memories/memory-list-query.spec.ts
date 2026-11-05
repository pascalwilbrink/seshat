import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { encodeCursor } from '../files/file-list-query.js';
import { parseMemoryListQuery } from './memory-list-query.js';

describe('parseMemoryListQuery', () => {
  it('defaults to active, newest first, limit 25', () => {
    expect(parseMemoryListQuery({})).toMatchObject({ limit: 25, status: 'active', cursor: null, type: null, tag: null, text: null });
  });

  it('parses and normalizes every filter', () => {
    const q = parseMemoryListQuery({
      limit: '10', type: 'fact', tag: ' Alpha ', status: 'all',
      createdFrom: '2026-01-01', createdTo: '2026-02-01T00:00:00.123456Z',
      updatedFrom: '2026-01-01T10:00:00+02:00', updatedTo: '2026-03-01T00:00Z', text: '50%_off',
    });
    expect(q).toMatchObject({ limit: 10, type: 'fact', tag: 'alpha', status: 'all', text: '50%_off', createdFrom: '2026-01-01T00:00:00.000Z', updatedFrom: '2026-01-01T08:00:00.000Z' });
  });

  it('accepts a cursor it produced', () => {
    const cursor = encodeCursor({ createdAt: '2026-01-01T00:00:00.123456Z', id: '3f2b8a52-6f0c-4c6e-9f43-0c1d0a5f6b11' });
    expect(parseMemoryListQuery({ cursor }).cursor).toEqual({ createdAt: '2026-01-01T00:00:00.123456Z', id: '3f2b8a52-6f0c-4c6e-9f43-0c1d0a5f6b11' });
  });

  it.each([
    [{ limit: '0' }], [{ limit: '101' }], [{ limit: 'x' }], [{ limit: '1e1' }],
    [{ type: 'nope' }], [{ status: 'deleted' }], [{ tag: 'bad tag!' }],
    [{ cursor: 'garbage' }], [{ cursor: '%%%' }],
    [{ createdFrom: 'yesterday' }], [{ createdFrom: '2026-13-45' }], [{ updatedTo: '0001-01-01' }],
    [{ createdFrom: '2026-02-01', createdTo: '2026-01-01' }],
    [{ updatedFrom: '2026-02-01', updatedTo: '2026-01-01' }],
    [{ unknown: '1' }], [{ type: ['fact', 'fact'] }], [{ text: 'x'.repeat(201) }],
  ])('rejects %j with a generic 400', (query) => {
    expect(() => parseMemoryListQuery(query)).toThrow(BadRequestException);
  });
});
