import { Injectable } from '@nestjs/common';
import type { Action, McpToolKind, McpToolRequirement } from '@seshat/domain';
import type { z } from 'zod';
import type { ApiKeyPrincipal } from '../auth/principal.js';
import type { McpClientContext } from '../memories/memory-provenance.js';
import type { ScopeRef } from '../scopes/scope-ref.js';
import type { ToolOutput } from './mcp-results.js';

/** Injection token for the process-wide tool registry (explicit: Vitest emits no decorator metadata). */
export const MCP_TOOL_REGISTRY = Symbol('MCP_TOOL_REGISTRY');

/** What a handler receives. `scope` is the key's Workspace; read tools may switch to Global via `resolveReadScope`. */
export interface McpToolContext {
  principal: ApiKeyPrincipal;
  scope: ScopeRef;
  client: McpClientContext | null;
}

export interface McpToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** snake_case tool name. */
  name: string;
  /** Written for agents: what it does, which scope, which permission. */
  description: string;
  inputSchema: S;
  /** `read`, `write` or `destructive`; decides the annotations. */
  kind: McpToolKind;
  /** Permissions needed to list and call the tool (same shape as the browser-safe domain catalog). */
  requires: McpToolRequirement;
  /** Domain actions re-checked through `AuthorizationService.assertCan` on every call (all must pass). */
  actions: readonly Action[];
  handler(input: z.infer<S>, ctx: McpToolContext): Promise<ToolOutput>;
}

/** A small typed registry. Production tools are registered by their module; the app registers none in this job. */
@Injectable()
export class McpToolRegistry {
  private readonly tools = new Map<string, McpToolDefinition>();

  register<S extends z.ZodObject>(tool: McpToolDefinition<S>): void {
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) throw new Error('Invalid MCP tool name');
    if (this.tools.has(tool.name)) throw new Error('Duplicate MCP tool name');
    this.tools.set(tool.name, tool as unknown as McpToolDefinition);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  get(name: string): McpToolDefinition | undefined {
    return this.tools.get(name);
  }

  all(): McpToolDefinition[] {
    return [...this.tools.values()];
  }
}
