import { z } from 'zod';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';

/** Input fragment for read tools: `scope: 'global'` reads Global (needs the Global grant). Writing tools never use it. */
export const readScopeFields = {
  scope: z
    .enum(['workspace', 'global'])
    .optional()
    .describe("Where to read: 'workspace' (default, the key's Workspace) or 'global' (needs the Global read grant)."),
};

/** Input fragment for search tools: `includeGlobal: true` adds Global results (needs the Global grant). */
export const searchScopeFields = {
  includeGlobal: z
    .boolean()
    .optional()
    .describe("Also search Global knowledge in addition to the key's Workspace (needs the Global read grant)."),
};

/** The key's own Workspace. Anything else is not reachable from a tool except Global through an explicit option. */
export function workspaceScopeOf(principal: Principal): ScopeRef {
  if (principal.kind !== 'apiKey') throw new Error('MCP requires an API key principal');
  return { kind: 'workspace', workspaceId: principal.workspaceId };
}

/** Resolves a read tool's `scope` option. Global is authorized later by AuthorizationService, never here. */
export function resolveReadScope(principal: Principal, scope: 'workspace' | 'global' | undefined): ScopeRef {
  return scope === 'global' ? globalScope() : workspaceScopeOf(principal);
}
