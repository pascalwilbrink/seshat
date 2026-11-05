import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import type { MemoryCreatedByKind } from './memory.entity.js';

/**
 * Trusted, internal MCP client context. It is supplied only by a future authenticated MCP adapter, in code, after it
 * has read the client's `initialize` info. It is never parsed from a REST body, query or arbitrary header, and no
 * REST schema in this module accepts it.
 */
export interface McpClientContext {
  name: string;
  version?: string | null;
}

export const CLIENT_NAME_MAX = 200;
export const CLIENT_VERSION_MAX = 100;

const clientContextSchema = z.strictObject({
  name: z.string().trim().min(1).max(CLIENT_NAME_MAX),
  version: z.string().trim().min(1).max(CLIENT_VERSION_MAX).nullish(),
});

/** The provenance columns of a Memory, written once on insert and never updated. */
export interface MemoryProvenance {
  createdByKind: MemoryCreatedByKind;
  createdByKeyId: string | null;
  createdByKeyName: string | null;
  clientName: string | null;
  clientVersion: string | null;
}

/**
 * Builds the provenance snapshot from the authenticated principal (admin, or API key id and the key's name at this
 * moment) and the optional trusted client context. The result is plain data copied from the principal, so later key
 * rename, revoke or deletion cannot change it. An invalid client context is a programming error in the trusted
 * caller and throws a fixed message (no values).
 */
export function buildMemoryProvenance(principal: Principal, client?: McpClientContext | null): MemoryProvenance {
  let clientName: string | null = null;
  let clientVersion: string | null = null;
  if (client !== undefined && client !== null) {
    const parsed = clientContextSchema.safeParse(client);
    if (!parsed.success) throw new Error('Invalid MCP client context');
    clientName = parsed.data.name;
    clientVersion = parsed.data.version ?? null;
  }
  if (principal.kind === 'admin') {
    return { createdByKind: 'admin', createdByKeyId: null, createdByKeyName: null, clientName, clientVersion };
  }
  return {
    createdByKind: 'api_key',
    createdByKeyId: principal.keyId,
    createdByKeyName: principal.keyName,
    clientName,
    clientVersion,
  };
}
