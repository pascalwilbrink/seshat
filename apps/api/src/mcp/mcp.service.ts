import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  JSONRPCRequestSchema,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { mcpAnnotationsFor, missingToolPermissions, satisfiesToolRequirement } from '@seshat/domain';
import { z } from 'zod';
import type { McpOutcome } from '../usage/usage.constants.js';
import type { TouchedResource } from '../usage/usage-batch.js';
import { UsageRecorderService } from '../usage/usage-recorder.service.js';
import { UsageCollector } from '../usage/usage-request-context.js';
import { summarizeArgs } from './mcp-args-summary.js';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { ApiKeyPrincipal } from '../auth/principal.js';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { resolveClientContext } from './mcp-client.js';
import { toSafeToolError } from './mcp-errors.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry, type McpToolDefinition } from './mcp-registry.js';
import type { ToolOutput } from './mcp-results.js';
import { emittedResourceKeys, measureResultChars, toolError, toolResult, wasTruncated } from './mcp-results.js';
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
/** Size recorded for an envelope the SDK rejects: the length of its generic protocol error message. */
const MCP_ERROR_ENVELOPE = 'Invalid request.';

/**
 * Call-history outcome for a safe error kind. `bad_request`, `too_large` and `conflict` are caller errors about the
 * request itself and are grouped under `validation_error`; anything unexpected is `internal_error`.
 */
function outcomeOf(kind: ReturnType<typeof toSafeToolError>['kind']): McpOutcome {
  switch (kind) {
    case 'not_found':
      return 'not_found';
    case 'forbidden':
      return 'forbidden';
    case 'validation':
    case 'bad_request':
    case 'too_large':
    case 'conflict':
      return 'validation_error';
    default:
      return 'internal_error';
  }
}

/** Tool name for history: a registered tool, otherwise a plain identifier-shaped name, otherwise a fixed label. */
function safeToolName(name: unknown, registry: McpToolRegistry): string {
  if (typeof name !== 'string') return '(invalid)';
  if (registry.get(name)) return name;
  return /^[a-z][a-z0-9_]{0,63}$/.test(name) ? name : '(unknown)';
}

@Injectable()
export class McpService {
  constructor(
    @Inject(MCP_TOOL_REGISTRY) private readonly registry: McpToolRegistry,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'mcpMaxResultChars'>,
    @Optional() @Inject(UsageCollector) private readonly usage?: UsageCollector,
    @Optional() @Inject(UsageRecorderService) private readonly recorder?: UsageRecorderService,
  ) {}

  /**
   * Records one `tools/call` after its result or error exists. Synchronous, no I/O (the recorder only buffers) and
   * wrapped so that nothing in it can change what the caller receives. `args` are summarized by the per-tool
   * allowlist; the raw value is never stored.
   */
  private record(
    principal: ApiKeyPrincipal,
    client: ReturnType<typeof resolveClientContext>,
    name: unknown,
    args: unknown,
    startedAt: Date,
    startedMs: number,
    outcome: McpOutcome,
    resultChars: number,
    truncated: boolean,
    touched: TouchedResource[],
  ): void {
    try {
      if (!this.recorder) return;
      this.recorder.enqueueMcpCall({
        occurredAt: startedAt,
        workspaceId: principal.workspaceId,
        keyId: principal.keyId,
        // Snapshot from authentication time, never a later key lookup.
        keyName: principal.keyName,
        clientName: client?.name ?? null,
        clientVersion: client?.version ?? null,
        tool: safeToolName(name, this.registry),
        outcome,
        durationMs: Math.max(0, Math.round(performance.now() - startedMs)),
        resultChars,
        truncated,
        argsSummary: typeof name === 'string' && this.registry.get(name) ? summarizeArgs(name, args) : {},
        touched,
      });
    } catch {
      /* best effort: recording never changes a result */
    }
  }

  /** Staged read/retrieved accesses of this request plus the writes the tool reported, as ids only. */
  private touchedOf(workspaceId: string, written: ToolOutput['touched']): TouchedResource[] {
    try {
      const ctx = this.usage?.current();
      const out: TouchedResource[] = (ctx?.stagedAccesses() ?? []).map((a) => ({
        resourceKind: a.resourceKind,
        resourceId: a.resourceId,
        scope: a.scope,
        action: a.accessKind,
      }));
      for (const t of ctx?.touched() ?? []) out.push(t);
      for (const w of written ?? []) out.push({ ...w, scope: { kind: 'workspace', workspaceId } });
      return out;
    } catch {
      return [];
    }
  }

  /** `tools/list` per key per UTC day; no call rows. */
  private countList(principal: ApiKeyPrincipal): void {
    try {
      this.recorder?.enqueueListCount({ workspaceId: principal.workspaceId, keyId: principal.keyId, keyName: principal.keyName });
    } catch {
      /* best effort */
    }
  }

  /**
   * A `tools/call` the SDK rejects before any handler runs (bad envelope, missing or non-string name, non-object
   * arguments) never reaches `callTool`; it is recorded here as a validation error so it is not silently missed.
   * Calls that parse are recorded by `callTool`, so nothing is recorded twice.
   */
  private recordMalformedCalls(principal: ApiKeyPrincipal, client: ReturnType<typeof resolveClientContext>, body: unknown): void {
    try {
      const messages = Array.isArray(body) ? body : [body];
      for (const message of messages) {
        if (typeof message !== 'object' || message === null || (message as { method?: unknown }).method !== 'tools/call') continue;
        if (JSONRPCRequestSchema.safeParse(message).success && CallToolRequestSchema.safeParse(message).success) continue;
        const name = (message as { params?: { name?: unknown } }).params?.name;
        this.record(principal, client, name, undefined, new Date(), performance.now(), 'validation_error', MCP_ERROR_ENVELOPE.length, false, []);
      }
    } catch {
      /* best effort */
    }
  }

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
    const startedAt = new Date();
    const startedMs = performance.now();
    const tool = typeof name === 'string' ? this.registry.get(name) : undefined;
    if (!tool || !satisfiesToolRequirement(tool.requires, principal.permissions)) {
      this.usage?.discard();
      // Hidden and unknown tools are recorded the same way and answered the same way.
      this.record(principal, client, name, args, startedAt, startedMs, 'unknown_tool', UNKNOWN_TOOL.length, false, []);
      throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
    }
    try {
      const scope = workspaceScopeOf(principal);
      for (const action of tool.actions) this.authorization.assertCan(principal, action, scope);
      const missing = missingToolPermissions(tool.requires, principal.permissions);
      if (missing.length > 0) throw new McpError(ErrorCode.InvalidParams, UNKNOWN_TOOL);
      const input = tool.inputSchema.parse(args ?? {});
      const output = await (tool as McpToolDefinition).handler(input, { principal, scope, client });
      const result = toolResult(output, this.config.mcpMaxResultChars);
      // Search-like tools: count only the resources the capped result really emits, never the pre-cap candidates.
      if (output.emitted) this.usage?.retainRetrieved(emittedResourceKeys(output, this.config.mcpMaxResultChars));
      this.record(
        principal, client, name, args, startedAt, startedMs, 'ok',
        measureResultChars(result), wasTruncated(output, this.config.mcpMaxResultChars), this.touchedOf(principal.workspaceId, output.touched),
      );
      return result;
    } catch (error) {
      // Failed or denied: nothing the call staged may count.
      this.usage?.discard();
      if (error instanceof McpError) {
        const hidden = error.message.endsWith(UNKNOWN_TOOL);
        this.record(principal, client, name, args, startedAt, startedMs, hidden ? 'unknown_tool' : 'internal_error', error.message.length, false, []);
        throw error;
      }
      const safe = toSafeToolError(error);
      const errorResult = toolError(safe.message);
      this.record(principal, client, name, args, startedAt, startedMs, outcomeOf(safe.kind), measureResultChars(errorResult), false, []);
      return errorResult;
    }
  }

  /** Serves one request: a fresh server and transport (stateless, no session ids). */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown, principal: ApiKeyPrincipal): Promise<void> {
    const client = resolveClientContext(body);
    this.recordMalformedCalls(principal, client, body);
    const server = new Server({ name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => {
      this.countList(principal);
      return { tools: this.listTools(principal) };
    });
    server.setRequestHandler(CallToolRequestSchema, (request) =>
      this.callTool(principal, request.params.name, request.params.arguments, client),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const run = async (): Promise<void> => {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    };
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    if (!this.usage) return run();
    // Request-local usage context (channel mcp); committed only when the response finished with 2xx, so a call that
    // failed or was denied (discarded in callTool) or a dropped connection counts nothing.
    const usage = this.usage;
    return usage.run('mcp', (ctx) => {
      res.once('finish', () => (res.statusCode >= 200 && res.statusCode < 300 ? usage.commit(ctx) : usage.discard(ctx)));
      res.once('close', () => usage.discard(ctx));
      return run();
    });
  }
}
