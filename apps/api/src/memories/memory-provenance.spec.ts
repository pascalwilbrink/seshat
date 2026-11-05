import { describe, expect, it } from 'vitest';
import { ADMIN_PRINCIPAL, type Principal } from '../auth/principal.js';
import { buildMemoryProvenance } from './memory-provenance.js';

const key: Principal = { kind: 'apiKey', keyId: 'k-1', keyName: 'ci agent', workspaceId: 'w', permissions: ['memories:write'] };

describe('buildMemoryProvenance', () => {
  it('snapshots an admin', () => {
    expect(buildMemoryProvenance(ADMIN_PRINCIPAL)).toEqual({
      createdByKind: 'admin', createdByKeyId: null, createdByKeyName: null, clientName: null, clientVersion: null,
    });
  });
  it('snapshots the key id and name', () => {
    expect(buildMemoryProvenance(key)).toMatchObject({ createdByKind: 'api_key', createdByKeyId: 'k-1', createdByKeyName: 'ci agent' });
  });
  it('keeps trusted client metadata when supplied and omits it otherwise', () => {
    expect(buildMemoryProvenance(key, { name: ' cursor ', version: '1.0' })).toMatchObject({ clientName: 'cursor', clientVersion: '1.0' });
    expect(buildMemoryProvenance(key, { name: 'cursor' })).toMatchObject({ clientName: 'cursor', clientVersion: null });
    expect(buildMemoryProvenance(key, null)).toMatchObject({ clientName: null, clientVersion: null });
    expect(buildMemoryProvenance(key)).toMatchObject({ clientName: null, clientVersion: null });
  });
  it('rejects an invalid or forged client context without echoing values', () => {
    expect(() => buildMemoryProvenance(key, { name: '' })).toThrow('Invalid MCP client context');
    expect(() => buildMemoryProvenance(key, { name: 'x'.repeat(201) })).toThrow('Invalid MCP client context');
    expect(() => buildMemoryProvenance(key, { name: 'x', createdByKeyId: 'forged' } as never)).toThrow('Invalid MCP client context');
  });
  it('is independent of later changes to the principal (key rename/revoke/deletion)', () => {
    const mutable = { ...key } as { keyName: string } & Principal;
    const snapshot = buildMemoryProvenance(mutable);
    mutable.keyName = 'renamed';
    expect(snapshot.createdByKeyName).toBe('ci agent');
  });
  it('ignores key-shaped extras on an admin principal', () => {
    const forged = { kind: 'admin', keyId: 'x', keyName: 'y' } as unknown as Principal;
    expect(buildMemoryProvenance(forged)).toMatchObject({ createdByKind: 'admin', createdByKeyId: null, createdByKeyName: null });
  });
});
