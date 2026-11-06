import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpAnnotationsFor, missingToolPermissions, satisfiesToolRequirement } from '@seshat/domain';
import { z } from 'zod';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { ApiKeyPrincipal } from '../auth/principal.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { resolveClientContext } from './mcp-client.js';
import { toSafeToolError } from './mcp-errors.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry, type McpToolDefinition } from './mcp-registry.js';
import { toolError, toolResult } from './mcp-results.js';
import { workspaceScopeOf } from './mcp-scope.js';

export const MCP_SERVER_NAME = 'seshat';

function readApiVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const MCP_SERVER_VERSION = readApiVersion();

const UNKNOWN_TOOL = 'Unknown tool.';

@Injectable()
export class McpService {
  constructor(
    @Inject(MCP_TOOL_REGISTRY) private readonly registry: McpToolRegistry,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'mcpMaxResultChars'>,
  ) {}

  /** Tools the key may see: its permissions satisfy the tool's requirement. */
  listTools(principal: ApiKeyPrincipal): Tool[] {
    return this.registry
      .all()
      .filter((t) => satisfiesToolRequirement(t.requires, principal.permissions))
      .map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: z.toJSONSchema(t.inputSchema, { io: 'input', target: 'draft-7' }) as Tool['inputSchema'],
        annotations: mcpAnnotationsFor(t.kind),
      }));
  }

  /**
   * Runs one tool call. An unknown tool and a tool the key may not see fail identically (protocol error, no name).
   * Authorization runs again here through AuthorizationService for every action of the tool.
   */
  async callTool(principal: ApiKeyPrincipal, name: unknown, args: unknown, client: ReturnType<typeof resolveClientContext>): Promise<CallToolResult> {
    const tool = typeof name === 'string' ? this.registry.get(name) : undefined;
    if (!tool || !satisfiesToolRequirement(tool.requires, principal.permissions)) {
      throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
    }
    try {
      const scope = workspaceScopeOf(principal);
      for (const action of tool.actions) this.authorization.assertCan(principal, action, scope);
      const missing = missingToolPermissions(tool.requires, principal.permissions);
      if (missing.length > 0) throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
      const input = tool.inputSchema.parse(args ?? {});
      const output = await (tool as McpToolDefinition).handler(input, { principal, scope, client });
      return toolResult(output, this.config.mcpMaxResultChars);
    } catch (error) {
      if (error instanceof McpError) throw error;
      return toolError(toSafeToolError(error).message);
    }
  }

  /** Serves one request: a fresh server and transport (stateless, no session ids). */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown, principal: ApiKeyPrincipal): Promise<void> {
    const client = resolveClientContext(body);
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: this.listTools(principal) }));
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(principal, request.params.name, request.params.arguments, client),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
