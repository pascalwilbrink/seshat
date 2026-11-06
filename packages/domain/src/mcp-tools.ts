import type { Permission } from './permissions.js';

/**
 * What a key needs to see and call an MCP tool. `allOf` permissions are all required; when `anyOf` is non-empty at
 * least one of them is also required (for example `search` + `files:read` is `allOf`, shared Tags are `anyOf`).
 * Browser-safe and free of server dependencies, so the web MCP page can show which tools a key gets.
 */
export interface McpToolRequirement {
  readonly allOf?: readonly Permission[];
  readonly anyOf?: readonly Permission[];
}

/** `read` tools only read, `write` tools mutate, `destructive` tools delete data. */
export type McpToolKind = 'read' | 'write' | 'destructive';

export interface McpToolCatalogEntry {
  readonly kind: McpToolKind;
  readonly requires: McpToolRequirement;
}

/**
 * The production tool catalog: tool name to kind and required permissions. The transport job ships it empty; each
 * tool job adds its entries here (and registers the tool in the API registry with the same requirement).
 */
export const MCP_TOOL_CATALOG = {} as const satisfies Record<string, McpToolCatalogEntry>;

export type McpToolName = keyof typeof MCP_TOOL_CATALOG;

/** True when the held permissions satisfy the requirement. `global:read` never satisfies an operation on its own. */
export function satisfiesToolRequirement(requires: McpToolRequirement, held: readonly Permission[]): boolean {
  return missingToolPermissions(requires, held).length === 0;
}

/** The permissions still missing: unmet `allOf` entries, or all `anyOf` entries when none is held. */
export function missingToolPermissions(requires: McpToolRequirement, held: readonly Permission[]): Permission[] {
  const have = new Set<Permission>(held);
  const missing = (requires.allOf ?? []).filter((p) => !have.has(p));
  const any = requires.anyOf ?? [];
  if (any.length > 0 && !any.some((p) => have.has(p))) missing.push(...any);
  return missing;
}

/** MCP annotations for a tool kind: read tools are read-only, destructive tools say so, other writes are not read-only. */
export function mcpAnnotationsFor(kind: McpToolKind): { readOnlyHint: boolean; destructiveHint: boolean } {
  return { readOnlyHint: kind === 'read', destructiveHint: kind === 'destructive' };
}

/** Names of the catalog tools a permission set may use (catalog order). Global reach is separate: see GLOBAL_READ_PERMISSION. */
export function catalogToolsFor(held: readonly Permission[]): string[] {
  return Object.entries(MCP_TOOL_CATALOG as Record<string, McpToolCatalogEntry>)
    .filter(([, entry]) => satisfiesToolRequirement(entry.requires, held))
    .map(([name]) => name);
}


