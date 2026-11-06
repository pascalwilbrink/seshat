import { MCP_TOOL_CATALOG, GLOBAL_READ_PERMISSION, satisfiesToolRequirement, type McpToolCatalogEntry, type McpToolKind, type McpToolRequirement, type Permission } from '@seshat/domain';

/** Development default: the API listens on 4200 and serves MCP at /mcp, outside the /api prefix. */
export const DEFAULT_MCP_URL = 'http://localhost:4200/mcp';

export interface McpEndpoint {
  url: string;
  /** True when the setting was set but not a usable http(s) URL, so the default is shown. */
  invalid: boolean;
}

/**
 * Validates the public MCP URL (`NEXT_PUBLIC_SESHAT_MCP_URL`). It must be an absolute http(s) URL without credentials, query or
 * fragment; trailing slashes are dropped. Anything else falls back to the development default and is flagged.
 */
export function resolveMcpEndpoint(raw: string | undefined): McpEndpoint {
  const value = raw?.trim();
  if (!value) return { url: DEFAULT_MCP_URL, invalid: false };
  try {
    const u = new URL(value);
    const ok = (u.protocol === 'http:' || u.protocol === 'https:') && !u.username && !u.password && !u.search && !u.hash && u.host !== '';
    if (!ok) return { url: DEFAULT_MCP_URL, invalid: true };
    return { url: `${u.origin}${u.pathname.replace(/\/+$/, '')}`, invalid: false };
  } catch {
    return { url: DEFAULT_MCP_URL, invalid: true };
  }
}

/** Read at build time: Next inlines `NEXT_PUBLIC_*` only for this literal form. */
export function publicMcpEndpoint(): McpEndpoint {
  return resolveMcpEndpoint(process.env.NEXT_PUBLIC_SESHAT_MCP_URL);
}

export const KEY_PLACEHOLDER = '<YOUR_SESHAT_API_KEY>';

/** Claude Code `.mcp.json`. Always the placeholder, never a real key or prefix. */
export function claudeCodeConfig(url: string): string {
  return JSON.stringify({ mcpServers: { seshat: { type: 'http', url, headers: { Authorization: `Bearer ${KEY_PLACEHOLDER}` } } } }, null, 2);
}

/** Gilde project MCP server: URL plus bearer token. */
export function gildeConfig(url: string): string {
  return JSON.stringify({ name: 'seshat', transport: 'streamable-http', url, authorization: `Bearer ${KEY_PLACEHOLDER}` }, null, 2);
}

export interface PreviewTool {
  name: string;
  kind: McpToolKind;
  requires: McpToolRequirement;
  /** Read tools reach Global only when the key holds `global:read`. */
  global: boolean;
}

export const KIND_LABEL: Record<McpToolKind, string> = { read: 'Read-only', write: 'Writing', destructive: 'Destructive' };

/** The catalog tools a key's permissions grant, in catalog order. */
export function toolsForPermissions(held: readonly Permission[]): PreviewTool[] {
  const hasGlobal = held.includes(GLOBAL_READ_PERMISSION);
  return Object.entries(MCP_TOOL_CATALOG as Record<string, McpToolCatalogEntry>)
    .filter(([, e]) => satisfiesToolRequirement(e.requires, held))
    .map(([name, e]) => ({ name, kind: e.kind, requires: e.requires, global: hasGlobal && e.kind === 'read' }));
}

/** "files:read" or "search + files:read or memories:read". */
export function describeRequirement(r: McpToolRequirement): string {
  const parts: string[] = [...(r.allOf ?? [])];
  const any = r.anyOf ?? [];
  if (any.length > 0) parts.push(any.join(' or '));
  return parts.join(' + ');
}
