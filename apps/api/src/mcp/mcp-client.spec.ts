import { describe, expect, it } from 'vitest';
import { resolveClientContext } from './mcp-client.js';
import { buildMemoryProvenance } from '../memories/memory-provenance.js';

describe('resolveClientContext', () => {
  it('reads initialize clientInfo and _meta.clientInfo', () => {
    expect(resolveClientContext({ method: 'initialize', params: { clientInfo: { name: ' gilde ', version: '1.2' } } })).toEqual({ name: 'gilde', version: '1.2' });
    expect(resolveClientContext({ method: 'tools/call', params: { _meta: { clientInfo: { name: 'claude-code' } } } })).toEqual({ name: 'claude-code', version: null });
  });

  it('gives null when there is no reliable source or the value is invalid', () => {
    expect(resolveClientContext(undefined)).toBeNull();
    expect(resolveClientContext({ method: 'tools/call', params: { name: 'x' } })).toBeNull();
    expect(resolveClientContext({ params: { clientInfo: { name: '' } } })).toBeNull();
    expect(resolveClientContext({ params: { clientInfo: { name: 'a'.repeat(201) } } })).toBeNull();
    expect(resolveClientContext({ params: { clientInfo: { name: 'a', version: 'v'.repeat(101) } } })).toBeNull();
    expect(resolveClientContext({ params: { clientInfo: 'nope' } })).toBeNull();
  });

  it('only ever yields a context that buildMemoryProvenance accepts', () => {
    const ctx = resolveClientContext({ params: { clientInfo: { name: 'agent', version: '9' } } });
    const p = buildMemoryProvenance({ kind: 'apiKey', keyId: 'k', keyName: 'n', workspaceId: 'w', permissions: [] }, ctx);
    expect(p.clientName).toBe('agent');
    expect(p.clientVersion).toBe('9');
  });
});
