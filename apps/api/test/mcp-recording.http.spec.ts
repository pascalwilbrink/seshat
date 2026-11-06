import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Logger, Module, NotFoundException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Permission } from '@seshat/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ApiKeyStore, type ApiKeyRecord } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock, LoginRateLimiter } from '../src/auth/login-rate-limiter.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { McpController } from '../src/mcp/mcp.controller.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { mcpIdSchema, McpNotFoundError } from '../src/mcp/mcp-errors.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from '../src/mcp/mcp-registry.js';
import { UsagePersistenceService } from '../src/usage/usage-persistence.service.js';
import { UsageRecorderService } from '../src/usage/usage-recorder.service.js';
import { UsageCollector } from '../src/usage/usage-request-context.js';
import type { UsageBatchInput } from '../src/usage/usage-batch.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';

const S = 'SENTINEL-rec-71d2';
const WORKSPACE_ID = randomUUID();
const FILE_ID = randomUUID();
const MEMORY_ID = randomUUID();
const KEY = 'sk_seshat_Rec00001_recordingsecret0123456789abcdefghijk';
const READ_KEY = 'sk_seshat_Rec00002_readonlysecret0123456789abcdefghijkl';

function record(name: string, permissions: Permission[]): ApiKeyRecord {
  return { id: randomUUID(), workspaceId: WORKSPACE_ID, name, prefix: name, permissions, createdAt: new Date(), expiresAt: null, lastUsedAt: null, revokedAt: null };
}
const RECORDS = new Map<string, ApiKeyRecord>([
  [KEY, record('recorder-key', ['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'search'])],
  [READ_KEY, record('reader-key', ['files:read'])],
]);

function sink() {
  const batches: UsageBatchInput[] = [];
  let failing = false;
  return {
    batches,
    fail: (v: boolean) => (failing = v),
    persistBatch: async (b: UsageBatchInput) => {
      if (failing) throw new Error(`${S} driver failure`);
      batches.push(b);
      return { status: 'applied' as const, accessRows: 0, skippedAccessResources: 0, mcpCalls: 0, skippedMcpCalls: 0, listRows: 0, skippedListRows: 0 };
    },
  };
}

async function boot() {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
  const store = { findByKey: async (p: string) => RECORDS.get(p) ?? null, touchLastUsed: async () => true };
  const fake = sink();

  @Module({
    imports: [ConfigModule],
    controllers: [McpController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService, LoginRateLimiter, SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: store },
      AuthorizationService,
      { provide: UsagePersistenceService, useValue: fake },
      { provide: UsageRecorderService, useFactory: () => new UsageRecorderService(fake) },
      { provide: UsageCollector, useFactory: (r: UsageRecorderService) => new UsageCollector(r), inject: [UsageRecorderService] },
      { provide: McpService, useFactory: (reg: McpToolRegistry, a: AuthorizationService, c: unknown, u: UsageCollector, r: UsageRecorderService) => new McpService(reg, a, c as never, u, r), inject: [MCP_TOOL_REGISTRY, AuthorizationService, 'APP_CONFIG_PROBE', UsageCollector, UsageRecorderService] },
      { provide: 'APP_CONFIG_PROBE', useValue: { mcpMaxResultChars: 2000 } },
      { provide: MCP_TOOL_REGISTRY, useFactory: () => new McpToolRegistry() },
    ],
  })
  class Root {}

  const app: INestApplication = await createApp(Root, { trustProxy: false }, false);
  await app.listen(0, '127.0.0.1');
  const registry = app.get<McpToolRegistry>(MCP_TOOL_REGISTRY);
  const usage = app.get(UsageCollector);
  registry.register({
    name: 'search_knowledge', description: 'test', kind: 'read', requires: { allOf: ['search', 'files:read'] }, actions: ['search.query'],
    inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().optional(), types: z.array(z.string()).optional() }),
    handler: async () => {
      usage.stage({ resourceKind: 'file', resourceId: FILE_ID, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID }, accessKind: 'retrieved' });
      return { structured: { results: [] }, text: `result ${S}-out` };
    },
  });
  registry.register({
    name: 'get_file', description: 'test', kind: 'read', requires: { allOf: ['files:read'] }, actions: ['file.get'],
    inputSchema: z.object({ fileId: mcpIdSchema }),
    handler: async () => {
      throw new McpNotFoundError();
    },
  });
  registry.register({
    name: 'list_files', description: 'test', kind: 'read', requires: { allOf: ['files:read'] }, actions: ['file.list'],
    inputSchema: z.object({ name: z.string().optional() }),
    handler: async () => {
      throw new Error(`${S} boom`);
    },
  });
  registry.register({
    name: 'forget', description: 'test', kind: 'destructive', requires: { allOf: ['files:read'] }, actions: ['file.list'],
    inputSchema: z.object({ id: z.string() }),
    handler: async (input) => ({ structured: { forgotten: true }, touched: [{ resourceKind: 'memory', resourceId: input.id, action: 'deleted' }] }),
  });
  registry.register({
    name: 'get_context', description: 'test', kind: 'read', requires: { allOf: ['files:read'] }, actions: ['file.list'],
    inputSchema: z.object({}),
    handler: async () => ({ structured: { blob: 'z'.repeat(5000) }, text: 'z'.repeat(5000) }),
  });
  registry.register({
    name: 'recall', description: 'test', kind: 'read', requires: { allOf: ['files:read'] }, actions: ['file.list'],
    inputSchema: z.object({}),
    handler: async () => {
      throw new NotFoundException();
    },
  });
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, base, fake, recorder: app.get(UsageRecorderService) };
}

let running: Awaited<ReturnType<typeof boot>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await running?.app.close();
  running = undefined;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function connect(key = KEY) {
  const client = new Client({ name: 'rec-client', version: '9.9' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running!.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}
const callFail = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  try { return await c.callTool({ name, arguments: args }); } catch (e) { return { thrown: (e as Error).message }; }
};
const calls = async () => {
  await running!.recorder.flush();
  return running!.fake.batches.flatMap((b) => b.mcpCalls ?? []);
};

describe('MCP call recording', () => {
  it('records one event per call for all six outcomes with the measurements and touched ids', async () => {
    running = await boot();
    const c = await connect();
    await c.callTool({ name: 'search_knowledge', arguments: { query: `${S}-query`, limit: 3 } });
    await callFail(c, 'get_file', { fileId: randomUUID() });
    await callFail(c, 'search_knowledge', { query: 5, extra: S });
    await callFail(c, 'list_files', {});
    await callFail(c, 'does_not_exist', { query: S });
    await callFail(c, 'get_context', {});
    await c.callTool({ name: 'forget', arguments: { id: MEMORY_ID } });
    const rows = await calls();
    expect(rows.map((r) => [r.tool, r.outcome])).toEqual([
      ['search_knowledge', 'ok'], ['get_file', 'not_found'], ['search_knowledge', 'validation_error'],
      ['list_files', 'internal_error'], ['does_not_exist', 'unknown_tool'], ['get_context', 'ok'], ['forget', 'ok'],
    ]);
    const [ok, , , , , big, forget] = rows;
    expect(ok).toMatchObject({ keyName: 'recorder-key', clientName: null, clientVersion: null, workspaceId: WORKSPACE_ID, truncated: false, argsSummary: { limit: 3 } });
    expect(ok!.durationMs).toBeGreaterThanOrEqual(0);
    expect(ok!.resultChars).toBeGreaterThan(0);
    expect(ok!.touched).toEqual([{ resourceKind: 'file', resourceId: FILE_ID, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID }, action: 'retrieved' }]);
    expect(big).toMatchObject({ truncated: true });
    expect(forget!.touched).toEqual([{ resourceKind: 'memory', resourceId: MEMORY_ID, scope: { kind: 'workspace', workspaceId: WORKSPACE_ID }, action: 'deleted' }]);
    expect(forget!.argsSummary).toEqual({ id: MEMORY_ID });
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('records a forbidden tool outcome and keeps hidden tools identical to unknown ones for the caller', async () => {
    running = await boot();
    const c = await connect(READ_KEY);
    const hidden = await callFail(c, 'search_knowledge', { query: S });
    const unknown = await callFail(c, 'no_such_tool', { query: S });
    expect((hidden as { thrown: string }).thrown).toBe((unknown as { thrown: string }).thrown);
    const rows = await calls();
    expect(rows.map((r) => r.outcome)).toEqual(['unknown_tool', 'unknown_tool']);
    expect(rows[0]!.argsSummary).toEqual({});
  });

  it('counts tools/list per key per day without call rows, and records nothing for 401s', async () => {
    running = await boot();
    const c = await connect();
    await c.listTools();
    await c.listTools();
    for (const bad of ['sk_seshat_Nope0000_x0123456789abcdefghijklmnopqrstuvwxyz', '']) {
      const res = await fetch(`${running.base}/mcp`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(bad ? { authorization: `Bearer ${bad}` } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {} } }),
      });
      expect(res.status).toBe(401);
    }
    await running.recorder.flush();
    expect(await calls()).toEqual([]);
    const lists = running.fake.batches.flatMap((b) => b.listCounts ?? []);
    expect(lists).toHaveLength(1);
    expect(lists[0]).toMatchObject({ keyName: 'recorder-key', count: 2 });
  });

  it('records malformed tools/call envelopes the SDK rejects', async () => {
    running = await boot();
    const res = await fetch(`${running.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 42, arguments: { query: S } } }),
    });
    expect(res.status).toBeLessThan(500);
    const rows = await calls();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: '(invalid)', outcome: 'validation_error', argsSummary: {} });
  });

  it('keeps the authentication-time key name when the key is renamed later', async () => {
    running = await boot();
    const c = await connect();
    await c.callTool({ name: 'get_context', arguments: {} });
    const rec = RECORDS.get(KEY)!;
    const original = rec.name;
    rec.name = 'renamed-later';
    try {
      const rows = await calls();
      expect(rows[0]!.keyName).toBe('recorder-key');
      await c.callTool({ name: 'get_context', arguments: {} });
      expect((await calls()).at(-1)!.keyName).toBe('renamed-later');
    } finally {
      rec.name = original;
    }
  });

  it('records the client asserted in the call body', async () => {
    running = await boot();
    const res = await fetch(`${running.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_context', arguments: {}, _meta: { clientInfo: { name: 'meta-client', version: '2.0' } } } }),
    });
    expect(res.status).toBe(200);
    expect((await calls())[0]).toMatchObject({ clientName: 'meta-client', clientVersion: '2.0' });
  });

  it('never alters results when enqueueing or flushing fails', async () => {
    running = await boot();
    const c = await connect();
    const before = await c.callTool({ name: 'search_knowledge', arguments: { query: 'q' } });
    vi.spyOn(running.recorder, 'enqueueMcpCall').mockImplementation(() => { throw new Error(S); });
    vi.spyOn(running.recorder, 'enqueueListCount').mockImplementation(() => { throw new Error(S); });
    const after = await c.callTool({ name: 'search_knowledge', arguments: { query: 'q' } });
    expect(after).toEqual(before);
    expect((await c.listTools()).tools.length).toBeGreaterThan(0);
    const err = await callFail(c, 'get_file', { fileId: randomUUID() });
    expect(JSON.stringify(err)).toContain('Not found.');
    vi.restoreAllMocks();
    running.fake.fail(true);
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await c.callTool({ name: 'search_knowledge', arguments: { query: 'q' } });
    await running.recorder.flush();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(S);
  });

  it('keeps sentinels out of persisted events, summaries and logs', async () => {
    running = await boot();
    const logs: unknown[] = [];
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose'] as const) vi.spyOn(Logger.prototype, m).mockImplementation((...a: unknown[]) => void logs.push(a));
    const c = await connect();
    await c.callTool({ name: 'search_knowledge', arguments: { query: `${S}-query`, types: ['files', `${S}-t`] } });
    await callFail(c, 'search_knowledge', { query: { nested: `${S}-bad` }, tags: [`${S}-tag`], metadata: { x: S } });
    await callFail(c, 'list_files', { name: `${S}-name` });
    await callFail(c, 'get_file', { fileId: `${S}-id`, text: S });
    await callFail(c, `${S}-toolname`, { query: S });
    const rows = await calls();
    expect(rows).toHaveLength(5);
    const persisted = JSON.stringify(running.fake.batches);
    expect(persisted).not.toContain(S);
    expect(JSON.stringify(logs)).not.toContain(S);
  });
});
