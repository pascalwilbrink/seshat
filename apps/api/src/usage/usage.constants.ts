export const USAGE_CHANNELS = ['ui', 'api', 'mcp'] as const;
export type UsageChannel = (typeof USAGE_CHANNELS)[number];

export const ACCESS_KINDS = ['read', 'retrieved'] as const;
export type AccessKind = (typeof ACCESS_KINDS)[number];

export const USAGE_RESOURCE_KINDS = ['file', 'memory'] as const;
export type UsageResourceKind = (typeof USAGE_RESOURCE_KINDS)[number];

export const MCP_OUTCOMES = ['ok', 'validation_error', 'forbidden', 'not_found', 'unknown_tool', 'internal_error'] as const;
export type McpOutcome = (typeof MCP_OUTCOMES)[number];

export const MCP_TOUCH_ACTIONS = ['read', 'retrieved', 'created', 'updated', 'deleted'] as const;
export type McpTouchAction = (typeof MCP_TOUCH_ACTIONS)[number];


/**
 * How long applied batch ids are remembered. Fixed, not configurable: a retry of an uncertain commit happens within
 * seconds, so a week is far beyond any retry while the ledger stays bounded.
 */
export const USAGE_BATCH_LEDGER_DAYS = 7;
