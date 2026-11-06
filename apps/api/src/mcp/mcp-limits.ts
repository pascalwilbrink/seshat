/** The MCP endpoint path. It is served outside the global `api` prefix. */
export const MCP_PATH = '/mcp';

/** JSON-RPC envelope allowance on top of the base64 payload (method, ids, other arguments). */
const ENVELOPE_BYTES = 64 * 1024;

/** True for `/mcp` and `/mcp/` (nothing below it is served). */
export function isMcpPath(path: string): boolean {
  return path === MCP_PATH || path === `${MCP_PATH}/`;
}

/** Largest `/mcp` request body: the upload cap as base64 (4 bytes per 3) plus the envelope. */
export function mcpBodyLimitBytes(maxUploadBytes: number): number {
  return Math.ceil(maxUploadBytes / 3) * 4 + ENVELOPE_BYTES;
}
