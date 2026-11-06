import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Inject, Module, NotFoundException } from '@nestjs/common';
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
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { McpController } from '../src/mcp/mcp.controller.js';
import { MCP_SERVER_VERSION, McpService } from '../src/mcp/mcp.service.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from '../src/mcp/mcp-registry.js';
import { McpNotFoundError, mcpIdSchema } from '../src/mcp/mcp-errors.js';
import { readScopeFields, resolveReadScope } from '../src/mcp/mcp-scope.js';
import { wrapRetrieved } from '../src/mcp/mcp-results.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';

const SENTINEL = 'SENTINEL-mcp-leak-4c7a';
const WORKSPACE_ID = randomUUID();
const OTHER_WORKSPACE_ID = randomUUID();

const KEYS = {
  readOnly: 'sk_seshat_Read0001_readonlysecret0123456789abcdefghijklm',
  readWrite: 'sk_seshat_Writ0002_readwritesecret0123456789abcdefghijk',
  global: 'sk_seshat_Glob0003_globalsecret0123456789abcdefghijklmn',
  searcher: 'sk_seshat_Srch0004_searchsecret0123456789abcdefghijklmn',
  revoked: 'sk_seshat_Revo0005_revokedsecret0123456789abcdefghijklm',
  expired: 'sk_seshat_Expi0006_expiredsecret0123456789abcdefghijklm',
  unknown: 'sk_seshat_Unkn0007_unknownsecret0123456789abcdefghijklm',
} as const;

function record(name: string, permissions: Permission[], extra: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: randomUUID(),
    workspaceId: WORKSPACE_ID,
    name,
    prefix: name,
    permissions,
    createdAt: new Date(),
    expiresAt: null,
    lastUsedAt: null,
    revokedAt: null,
    ...extra,
  };
}

const RECORDS = new Map<string, ApiKeyRecord>([
  [KEYS.readOnly, record('ro', ['files:read', 'memories:read'])],
  [KEYS.readWrite, record('rw', ['files:read', 'files:write', 'files:delete'])],
  [KEYS.global, record('gl', ['files:read', 'global:read'])],
  [KEYS.searcher, record('se', ['search', 'files:read'])],
  [KEYS.revoked, record('rv', ['files:read'], { revokedAt: new Date() })],
  [KEYS.expired, record('ex', ['files:read'], { expiresAt: new Date(Date.now() - 1000) })],
]);

/** Test-only tools. They are registered into the registry of this test app only, never in the running application. */
function registerTestTools(registry: McpToolRegistry, authz: AuthorizationService, seen: { client: unknown[] }) {
  registry.register({
    name: 'test_read',
    description: 'Test-only read tool.',
    inputSchema: z.object({ id: mcpIdSchema.optional(), ...readScopeFields, q: z.string().min(1).optional() }),
    kind: 'read',
    requires: { allOf: ['files:read'] },
    actions: ['file.list'],
    async handler(input, ctx) {
      seen.client.push(ctx.client);
      const scope = resolveReadScope(ctx.principal, input.scope);
      authz.assertCan(ctx.principal, 'file.list', scope);
      if (input.id) throw new NotFoundException(`${SENTINEL} missing`);
      return { structured: { scope: scope.kind, items: [] }, text: wrapRetrieved('test', 'data') };
    },
  });
  registry.register({
    name: 'test_write',
    description: 'Test-only write tool.',
    inputSchema: z.object({ name: z.string() }),
    kind: 'write',
    requires: { allOf: ['files:write'] },
    actions: ['file.upload'],
    handler: async () => ({ structured: { ok: true } }),
  });
  registry.register({
    name: 'test_destroy',
    description: 'Test-only destructive tool.',
    inputSchema: z.object({}),
    kind: 'destructive',
    requires: { allOf: ['files:delete'] },
    actions: ['file.delete'],
    handler: async () => ({ structured: { deleted: true } }),
  });
  registry.register({
    name: 'test_search',
    description: 'Test-only search tool.',
    inputSchema: z.object({}),
    kind: 'read',
    requires: { allOf: ['search', 'files:read'] },
    actions: ['search.query'],
    handler: async () => ({ structured: { results: [] } }),
  });
  registry.register({
    name: 'test_big',
    description: 'Test-only large result.',
    inputSchema: z.object({}),
    kind: 'read',
    requires: { allOf: ['files:read'] },
    actions: ['file.list'],
    handler: async () => ({ structured: { blob: 'z'.repeat(50_000) }, text: wrapRetrieved('big', 'z'.repeat(50_000)) }),
  });
  registry.register({
    name: 'test_boom',
    description: 'Test-only failing tool.',
    inputSchema: z.object({}),
    kind: 'read',
    requires: { allOf: ['files:read'] },
    actions: ['file.list'],
    handler: async () => {
      throw Object.assign(new Error(`${SENTINEL} SELECT secret FROM keys /etc/passwd`), { stack: SENTINEL });
    },
  });
  registry.register({
    name: 'test_notfound',
    description: 'Test-only not-found tool.',
    inputSchema: z.object({ id: mcpIdSchema }),
    kind: 'read',
    requires: { allOf: ['files:read'] },
    actions: ['file.get'],
    handler: async () => {
      throw new McpNotFoundError();
    },
  });
}

async function boot(uploadCap?: number) {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
    vi.stubEnv(k, v);
  }
  const store = {
    findByKey: async (presented: string) => RECORDS.get(presented) ?? null,
    touchLastUsed: async () => true,
  };

  @Module({
    imports: [ConfigModule],
    controllers: [McpController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      LoginRateLimiter,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: store },
      AuthorizationService,
      McpService,
      { provide: MCP_TOOL_REGISTRY, useFactory: () => new McpToolRegistry() },
    ],
  })
  class Root {}

  const app: INestApplication = await createApp(Root, { trustProxy: false, ...(uploadCap === undefined ? {} : { mcpMaxUploadBytes: uploadCap }) }, false);
  await app.listen(0, '127.0.0.1');
  const seen: { client: unknown[] } = { client: [] };
  registerTestTools(app.get(MCP_TOOL_REGISTRY), app.get(AuthorizationService), seen);
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  return { app, base, cookie, seen };
}

let running: Awaited<ReturnType<typeof boot>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await running?.app.close();
  running = undefined;
  vi.unstubAllEnvs();
});

async function connect(key: string, clientInfo = { name: 'test-client', version: '1.2.3' }) {
  const client = new Client(clientInfo);
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running!.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

const rpc = (method: string, params: unknown = {}, id = 1) => JSON.stringify({ jsonrpc: '2.0', id, method, params });
const INIT = rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'raw', version: '1' } });
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

describe('/mcp over HTTP with the SDK client', () => {
  it('initializes as "seshat" with the API version and no session id', async () => {
    running = await boot();
    const client = await connect(KEYS.readOnly);
    expect(client.getServerVersion()).toEqual({ name: 'seshat', version: MCP_SERVER_VERSION });
    expect(MCP_SERVER_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    const res = await fetch(`${running.base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, authorization: `Bearer ${KEYS.readOnly}` }, body: INIT });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeNull();
  });

  it('lists exactly the tools each permission set allows, with the annotation rules', async () => {
    running = await boot();
    const names = async (key: string) => (await (await connect(key)).listTools()).tools.map((t) => t.name).sort();
    expect(await names(KEYS.readOnly)).toEqual(['test_big', 'test_boom', 'test_notfound', 'test_read']);
    expect(await names(KEYS.readWrite)).toEqual(['test_big', 'test_boom', 'test_destroy', 'test_notfound', 'test_read', 'test_write']);
    expect(await names(KEYS.searcher)).toEqual(['test_big', 'test_boom', 'test_notfound', 'test_read', 'test_search']);
    expect(await names(KEYS.global)).toEqual(['test_big', 'test_boom', 'test_notfound', 'test_read']);

    const tools = (await (await connect(KEYS.readWrite)).listTools()).tools;
    const by = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(by.test_read).toMatchObject({ readOnlyHint: true });
    expect(by.test_write).toMatchObject({ readOnlyHint: false });
    expect(by.test_write?.destructiveHint).not.toBe(true);
    expect(by.test_destroy).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    const read = tools.find((t) => t.name === 'test_read')!;
    expect(read.inputSchema.type).toBe('object');
    expect(Object.keys(read.inputSchema.properties ?? {})).toEqual(['id', 'scope', 'q']);
  });

  it('calls a listed tool and treats an unlisted tool exactly like an unknown one', async () => {
    running = await boot();
    const client = await connect(KEYS.readOnly);
    const ok = await client.callTool({ name: 'test_read', arguments: {} });
    expect(ok.isError).toBeFalsy();
    expect(ok.structuredContent).toEqual({ scope: 'workspace', items: [] });

    const failure = async (name: string) => {
      try {
        await client.callTool({ name, arguments: {} });
        return 'no error';
      } catch (e) {
        return (e as Error).message;
      }
    };
    const unlisted = await failure('test_write');
    const unknown = await failure('does_not_exist');
    expect(unlisted).toBe(unknown);
    expect(unlisted).not.toContain('test_write');
    expect(unlisted).toContain('Unknown tool');
  });

  it('re-authorizes through AuthorizationService: Global needs the grant, even inside a listed tool', async () => {
    running = await boot();
    const denied = await (await connect(KEYS.readOnly)).callTool({ name: 'test_read', arguments: { scope: 'global' } });
    expect(denied.isError).toBe(true);
    expect(JSON.stringify(denied)).toContain('Not found.');
    const granted = await (await connect(KEYS.global)).callTool({ name: 'test_read', arguments: { scope: 'global' } });
    expect(granted.isError).toBeFalsy();
    expect(granted.structuredContent).toMatchObject({ scope: 'global' });
  });

  it('answers validation, not-found, internal and size problems with short safe tool errors', async () => {
    running = await boot();
    const client = await connect(KEYS.readOnly);
    const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;

    const invalid = await client.callTool({ name: 'test_read', arguments: { q: '' } });
    expect(invalid.isError).toBe(true);
    expect(text(invalid)).toBe('Invalid input: q.');

    const random = await client.callTool({ name: 'test_notfound', arguments: { id: randomUUID() } });
    const malformed = await client.callTool({ name: 'test_notfound', arguments: { id: 'nope' } });
    const viaService = await client.callTool({ name: 'test_read', arguments: { id: randomUUID() } });
    expect(random.isError && malformed.isError && viaService.isError).toBe(true);
    expect(text(random)).toBe(text(malformed));
    expect(text(random)).toBe(text(viaService));

    const boom = await client.callTool({ name: 'test_boom', arguments: {} });
    expect(boom.isError).toBe(true);
    expect(JSON.stringify(boom)).not.toContain('SENTINEL');
    expect(JSON.stringify(boom)).not.toMatch(/SELECT|passwd|stack/);
    expect(text(boom)).toBe('Internal error.');

    const big = await client.callTool({ name: 'test_big', arguments: {} });
    expect(text(big).length).toBeLessThanOrEqual(20_000);
    expect(text(big)).toContain('truncated');
    expect(big.structuredContent).toMatchObject({ truncated: true });
  });

  it('passes the client name and version from the request body, otherwise null', async () => {
    running = await boot();
    const client = await connect(KEYS.readOnly);
    await client.callTool({ name: 'test_read', arguments: {} });
    expect(running.seen.client.at(-1)).toBeNull();
    const res = await fetch(`${running.base}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, authorization: `Bearer ${KEYS.readOnly}` },
      body: rpc('tools/call', { name: 'test_read', arguments: {}, _meta: { clientInfo: { name: 'agent-x', version: '4' } } }),
    });
    expect(res.status).toBe(200);
    expect(running.seen.client.at(-1)).toEqual({ name: 'agent-x', version: '4' });
  });
});

describe('/mcp authentication', () => {
  const challenge = async (headers: Record<string, string>) => {
    const res = await fetch(`${running!.base}/mcp`, { method: 'POST', headers: { ...MCP_HEADERS, ...headers }, body: INIT });
    return { status: res.status, www: res.headers.get('www-authenticate'), text: await res.text(), setCookie: res.headers.getSetCookie() };
  };

  it('answers 401 with a Bearer challenge and a detail-free body for every failure, identically', async () => {
    running = await boot();
    const cases: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${KEYS.unknown}` },
      { authorization: `Bearer ${KEYS.revoked}` },
      { authorization: `Bearer ${KEYS.expired}` },
      { authorization: 'Bearer ' + SENTINEL },
      { authorization: `Basic ${SENTINEL}` },
      { cookie: running.cookie },
      { cookie: running.cookie, authorization: `Bearer ${KEYS.readOnly}` },
      { cookie: `${SESSION_COOKIE_NAME}=garbage`, authorization: `Bearer ${KEYS.readOnly}` },
    ];
    const results = [];
    for (const headers of cases) results.push(await challenge(headers));
    for (const r of results) {
      expect(r.status).toBe(401);
      expect(r.www).toBe('Bearer');
      expect(r.setCookie).toEqual([]);
      expect(r.text).not.toContain('SENTINEL');
    }
    expect(new Set(results.map((r) => r.text)).size).toBe(1);
  });

  it('does not accept the session cookie as a credential and answers non-POST methods with 405 for valid keys', async () => {
    running = await boot();
    expect((await challenge({ cookie: running.cookie })).status).toBe(401);
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`${running.base}/mcp`, { method, headers: { authorization: `Bearer ${KEYS.readOnly}` } });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
      await res.text();
      const anon = await fetch(`${running.base}/mcp`, { method });
      expect(anon.status).toBe(401);
      await anon.text();
    }
  });

  it('is not served under the api prefix', async () => {
    running = await boot();
    const res = await fetch(`${running.base}/api/mcp`, { method: 'POST', headers: { authorization: `Bearer ${KEYS.readOnly}`, 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(404); // no route: the MCP controller is excluded from the prefix
    await res.text();
  });
});

describe('/mcp body limit', () => {
  it('accepts bodies sized for the upload cap and rejects larger ones with a fixed message', async () => {
    running = await boot(30_000);
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${KEYS.readOnly}` };
    const sized = (n: number) => rpc('tools/call', { name: 'test_read', arguments: { q: 'x'.repeat(n) } });

    const fits = await fetch(`${running.base}/mcp`, { method: 'POST', headers, body: sized(40_000) });
    expect(fits.status).toBe(200);
    await fits.text();

    const tooBig = await fetch(`${running.base}/mcp`, { method: 'POST', headers, body: sized(200_000 + SENTINEL.length) });
    expect(tooBig.status).toBe(413);
    const body = await tooBig.text();
    expect(JSON.parse(body)).toEqual({ statusCode: 413, message: 'Payload too large' });
    expect(body).not.toContain('xxxx');

    const malformed = await fetch(`${running.base}/mcp`, { method: 'POST', headers, body: `{"a": "${SENTINEL}` });
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).not.toContain('SENTINEL');
  });

  it('keeps 16 KB on every other route', async () => {
    running = await boot();
    const res = await fetch(`${running.base}/api/other`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(20_000) }) });
    expect(res.status).toBe(413);
    expect(JSON.parse(await res.text())).toEqual({ statusCode: 413, message: 'Payload too large' });
  });
});
