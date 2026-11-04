import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, parseFileListQuery } from './file-list-query.js';

describe('parseFileListQuery', () => {
  it('applies defaults and normalizes values', () => {
    const id = randomUUID().toUpperCase();
    expect(parseFileListQuery({})).toEqual({ limit: 25, cursor: null, collectionId: null, tag: null, status: null, name: null });
    expect(parseFileListQuery({ limit: '100', collectionId: id, tag: ' Project/X ', status: 'failed', name: '50%_off' })).toMatchObject({
      limit: 100,
      collectionId: id.toLowerCase(),
      tag: 'project/x',
      status: 'failed',
      name: '50%_off',
    });
    expect(parseFileListQuery({ name: '', tag: '', limit: '' }).name).toBeNull();
  });

  it.each([
    { limit: '0' },
    { limit: '101' },
    { limit: '-1' },
    { limit: '1e2' },
    { limit: ['1', '2'] },
    { collectionId: 'nope' },
    { tag: 'bad tag!' },
    { status: 'done' },
    { name: 'x'.repeat(256) },
    { unknown: '1' },
  ])('rejects %j with a generic 400', (q) => {
    expect(() => parseFileListQuery(q)).toThrow(/Invalid query/);
  });
});

describe('cursor', () => {
  const cursor = { createdAt: '2026-01-02T03:04:05.123456Z', id: randomUUID() };

  it('round-trips and is opaque url-safe text', () => {
    const raw = encodeCursor(cursor);
    expect(raw).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(raw)).toEqual(cursor);
  });

  it.each([
    '',
    '!!!',
    'x'.repeat(300),
    Buffer.from('not json').toString('base64url'),
    Buffer.from(JSON.stringify({ a: 1 })).toString('base64url'),
    Buffer.from(JSON.stringify(['2026-01-02', randomUUID()])).toString('base64url'),
    Buffer.from(JSON.stringify(['2026-01-02T03:04:05.123456Z', "x'; DROP TABLE files;--"])).toString('base64url'),
    Buffer.from(JSON.stringify(['2026-13-45T03:04:05.123456Z', randomUUID()])).toString('base64url'),
  ])('rejects malformed cursor %#', (raw) => {
    expect(() => decodeCursor(raw)).toThrow(/Invalid cursor/);
  });
});
