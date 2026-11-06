import { z } from 'zod';
import { CLIENT_NAME_MAX, CLIENT_VERSION_MAX, type McpClientContext } from '../memories/memory-provenance.js';

const clientInfoSchema = z.object({
  name: z.string().trim().min(1).max(CLIENT_NAME_MAX),
  version: z.string().trim().min(1).max(CLIENT_VERSION_MAX).nullish(),
});

/**
 * Where the MCP client name and version come from in stateless mode.
 *
 * The transport keeps no session, so the `initialize` request (which carries `params.clientInfo`) is not seen by
 * later `tools/call` requests, and the standard SDK client sends no client header either. The only sources this
 * server reads are therefore in the request body of the call itself:
 *   1. `params.clientInfo` (present on `initialize`);
 *   2. `params._meta.clientInfo` (a client that repeats its info on every call).
 * Both are validated with the provenance limits; anything else, or an invalid value, gives `null`. Headers such as
 * User-Agent are never trusted. The value is a label asserted by the authenticated key's holder, recorded as
 * provenance only; it never influences authorization.
 */
export function resolveClientContext(body: unknown): McpClientContext | null {
  const first = Array.isArray(body) ? body[0] : body;
  const params = (first as { params?: unknown } | null | undefined)?.params;
  if (typeof params !== 'object' || params === null) return null;
  const record = params as { clientInfo?: unknown; _meta?: unknown };
  const meta = typeof record._meta === 'object' && record._meta !== null ? (record._meta as { clientInfo?: unknown }) : undefined;
  for (const candidate of [record.clientInfo, meta?.clientInfo]) {
    if (candidate === undefined) continue;
    const parsed = clientInfoSchema.safeParse(candidate);
    return parsed.success ? { name: parsed.data.name, version: parsed.data.version ?? null } : null;
  }
  return null;
}
