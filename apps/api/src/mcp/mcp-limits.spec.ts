import { describe, expect, it } from 'vitest';
import { isMcpPath, mcpBodyLimitBytes } from './mcp-limits.js';

describe('mcp limits', () => {
  it('derives the body limit from the upload cap with base64 overhead', () => {
    const cap = 10 * 1024 * 1024;
    const limit = mcpBodyLimitBytes(cap);
    // The base64 form of a file at the cap fits, with room for the envelope.
    expect(limit).toBeGreaterThan(Math.ceil(cap / 3) * 4);
    expect(limit).toBeLessThan(cap * 1.4);
    expect(mcpBodyLimitBytes(1)).toBeGreaterThan(16 * 1024);
  });

  it('recognises only /mcp', () => {
    expect(isMcpPath('/mcp')).toBe(true);
    expect(isMcpPath('/mcp/')).toBe(true);
    for (const p of ['/api/mcp', '/mcp/x', '/MCP', '/mcpx', '/']) expect(isMcpPath(p)).toBe(false);
  });
});
