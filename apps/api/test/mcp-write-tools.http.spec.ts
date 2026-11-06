import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { BadRequestException, type INestApplication, Module, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_TOOL_CATALOG, type Permission } from '@seshat/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeyStore, type ApiKeyRecord } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock, LoginRateLimiter } from '../src/auth/login-rate-limiter.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { FilesService } from '../src/files/files.service.js';
import { McpController } from '../src/mcp/mcp.controller.js';
import { McpService } from '../src/mcp/mcp.service.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from '../src/mcp/mcp-registry.js';
import { McpWriteTools } from '../src/mcp/mcp-write-tools.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';

const SENTINEL = 'SENTINEL-write-tools-9d2b';
const WORKSPACE_ID = randomUUID();
const CAP = 2000;

const KEYS = {
  reader: 'sk_seshat_Read0001_readersecret0123456789abcdefghijklmnop',
  writer: 'sk_seshat_Writ0002_writersecret0123456789abcdefghijklmnop',
  deleter: 'sk_seshat_Dele0003_deletersecret0123456789abcdefghijklmn',
  memWriter: 'sk_seshat_Memw0004_memwritersecret0123456789abcdefghijkl',
  full: 'sk_seshat_Full0005_fullsecret0123456789abcdefghijklmnopqrs',
} as const;

const record = (name: string, permissions: Permission[]): ApiKeyRecord => ({
  id: randomUUID(), workspaceId: WORKSPACE_ID, name, prefix: name, permissions, createdAt: new Date(), expiresAt: null, lastUsedAt: null, revokedAt: null,
});
const ALL: Permission[] = ['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'memories:delete', 'global:read'];
const RECORDS = new Map<string, ApiKeyRecord>([
  [KEYS.reader, record('reader', ['files:read', 'memories:read', 'global:read'])],
  [KEYS.writer, record('writer', ['files:read', 'files:write'])],
  [KEYS.deleter, record('deleter', ['files:delete'])],
  [KEYS.memWriter, record('memw', ['memories:write'])],
  [KEYS.full, record('full', ALL)],
]);

/** Fakes record how the real tool layer calls the services; the services enforce authorization like the real ones. */
function fakes(authz: AuthorizationService) {
  const calls: { op: string; args: unknown[] }[] = [];
  const files = {
    async uploadBuffer(principal: never, scope: never, input: { name: string; content: Buffer; collectionId?: string | null }, client: unknown, maxBytes: number) {
      authz.assertCan(principal, 'file.upload', scope);
      if (input.content.length > maxBytes) throw new PayloadTooLargeException('Payload too large');
      if (input.collectionId === 'foreign') throw new BadRequestException(`${SENTINEL} collection`);
      calls.push({ op: 'uploadBuffer', args: [input, client, scope] });
      return { id: randomUUID(), name: input.name, sizeBytes: input.content.length, ingestionStatus: 'pending', scope: 'workspace' };
    },
    async remove(principal: never, scope: never, id: string) {
      authz.assertCan(principal, 'file.delete', scope);
      if (id !== KNOWN_ID) throw new NotFoundException(`Not Found ${SENTINEL}`);
      calls.push({ op: 'remove', args: [id, scope] });
    },
  };
  const memories = {
    async create(principal: never, scope: never, input: Record<string, unknown>, client: unknown) {
      authz.assertCan(principal, 'memory.remember', scope);
      calls.push({ op: 'create', args: [input, client, scope] });
      return { id: randomUUID(), ...input, status: 'active', deduplicated: false, hints: [] };
    },
    async update(principal: never, scope: never, id: string, input: Record<string, unknown>) {
      authz.assertCan(principal, 'memory.update', scope);
      if (id !== KNOWN_ID) throw new NotFoundException(SENTINEL);
      calls.push({ op: 'update', args: [id, input] });
      return { id, ...input, status: 'active' };
    },
    async remove(principal: never, scope: never, id: string) {
      authz.assertCan(principal, 'memory.forget', scope);
      if (id !== KNOWN_ID) throw new NotFoundException(SENTINEL);
      calls.push({ op: 'forget', args: [id] });
    },
  };
  return { calls, files, memories };
}
const KNOWN_ID = randomUUID();

async function boot() {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test', MCP_MAX_UPLOAD_BYTES: String(CAP) })) vi.stubEnv(k, v);
  const store = { findByKey: async (presented: string) => RECORDS.get(presented) ?? null, touchLastUsed: async () => true };
  const f = fakes(new AuthorizationService());
  const holder = { calls: f.calls };

  @Module({
    imports: [ConfigModule],
    controllers: [McpController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService, LoginRateLimiter, SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: store },
      AuthorizationService, McpService, McpWriteTools,
      { provide: MCP_TOOL_REGISTRY, useFactory: () => new McpToolRegistry() },
      { provide: FilesService, useValue: f.files },
      { provide: MemoriesService, useValue: f.memories },
    ],
  })
  class Root {}

  const app: INestApplication = await createApp(Root, { trustProxy: false, mcpMaxUploadBytes: CAP }, false);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  return { app, base, holder };
}

let running: Awaited<ReturnType<typeof boot>> | undefined;
const clients: Client[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close().catch(() => undefined);
  await running?.app.close();
  running = undefined;
  vi.unstubAllEnvs();
});

async function connect(key: string) {
  const client = new Client({ name: 'agent-x', version: '9.1' });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(`${running!.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}
const text = (r: unknown) => ((r as { content: { text: string }[] }).content[0] as { text: string }).text;
const call = async (key: string, name: string, args: Record<string, unknown>) => (await connect(key)).callTool({ name, arguments: args });
/** The stateless transport only sees client info inside the call itself (`_meta.clientInfo`); the SDK client sends it on initialize only. */
async function rawCall(key: string, name: string, args: Record<string, unknown>, clientInfo: { name: string; version: string } | null = { name: 'agent-x', version: '9.1' }) {
  const res = await fetch(`${running!.base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${key}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args, ...(clientInfo ? { _meta: { clientInfo } } : {}) } }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { result: { isError?: boolean; structuredContent?: unknown; content: { text: string }[] } };
}
const lastCall = () => running!.holder.calls.at(-1)!;

describe('write tools: listing, permissions and annotations', () => {
  it('lists exactly the writing tools a key may use, with the annotation rules from the catalog', async () => {
    running = await boot();
    const names = async (key: string) => (await (await connect(key)).listTools()).tools.map((t) => t.name).sort();
    expect(await names(KEYS.reader)).toEqual([]);
    expect(await names(KEYS.writer)).toEqual(['upload_file']);
    expect(await names(KEYS.deleter)).toEqual(['delete_file']);
    expect(await names(KEYS.memWriter)).toEqual(['remember', 'update_memory']);
    expect(await names(KEYS.full)).toEqual(['delete_file', 'forget', 'remember', 'update_memory', 'upload_file']);

    const by = Object.fromEntries((await (await connect(KEYS.full)).listTools()).tools.map((t) => [t.name, t.annotations]));
    for (const n of ['upload_file', 'remember', 'update_memory']) {
      expect(by[n]).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    }
    for (const n of ['delete_file', 'forget']) expect(by[n]).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(MCP_TOOL_CATALOG.forget.requires).toEqual({ allOf: ['memories:delete'] });
  });

  it('never offers a scope or Global option: the schemas are closed and the scope is the key Workspace', async () => {
    running = await boot();
    for (const t of (await (await connect(KEYS.full)).listTools()).tools) {
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('scope');
      expect(Object.keys(t.inputSchema.properties ?? {})).not.toContain('includeGlobal');
    }
    for (const [tool, args] of [
      ['upload_file', { name: 'a.md', text: 'x', scope: 'global' }],
      ['remember', { type: 'fact', content: 'x', scope: 'global' }],
      ['forget', { id: KNOWN_ID, scope: 'global' }],
    ] as const) {
      const r = await call(KEYS.full, tool, { ...args });
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Invalid input: (unexpected field).');
    }
    expect(running.holder.calls).toEqual([]);
  });

  it('treats a tool the key lacks permission for exactly like an unknown tool, even when called directly', async () => {
    running = await boot();
    const fail = async (key: string, name: string, args: Record<string, unknown>) => {
      try { await call(key, name, args); return 'no error'; } catch (e) { return (e as Error).message; }
    };
    const denied = await fail(KEYS.reader, 'upload_file', { name: 'a.md', text: 'x' });
    expect(denied).toBe(await fail(KEYS.reader, 'does_not_exist', {}));
    expect(await fail(KEYS.writer, 'forget', { id: KNOWN_ID })).toBe(denied);
    expect(await fail(KEYS.writer, 'delete_file', { id: KNOWN_ID })).toBe(denied);
    expect(await fail(KEYS.memWriter, 'forget', { id: KNOWN_ID })).toBe(denied);
    expect(running.holder.calls).toEqual([]);
  });
});

describe('upload_file', () => {
  it('uploads UTF-8 text and passes the MCP client and the key Workspace', async () => {
    running = await boot();
    const { result: r } = await rawCall(KEYS.writer, 'upload_file', { name: 'notes.md', text: '# héllo', tags: ['a'], collectionId: randomUUID() });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ file: { name: 'notes.md', sizeBytes: 8, ingestionStatus: 'pending' } });
    const [input, client, scope] = lastCall().args as [{ content: Buffer; mimeType: string; tags: string[] }, unknown, unknown];
    expect(input.content.toString('utf8')).toBe('# héllo');
    expect(input.mimeType).toBe('text/plain');
    expect(input.tags).toEqual(['a']);
    expect(client).toEqual({ name: 'agent-x', version: '9.1' });
    expect(scope).toEqual({ kind: 'workspace', workspaceId: WORKSPACE_ID });
  });

  it('uploads base64 content byte for byte', async () => {
    running = await boot();
    const bytes = Buffer.from([0, 255, 1, 2, 3, 250]);
    const r = await call(KEYS.writer, 'upload_file', { name: 'b.bin', base64: bytes.toString('base64') });
    expect(r.isError).toBeFalsy();
    expect(((lastCall().args[0] as { content: Buffer }).content).equals(bytes)).toBe(true);
    expect((lastCall().args[0] as { mimeType: string }).mimeType).toBe('application/octet-stream');
  });

  it('rejects invalid base64 and the wrong content combination without storing', async () => {
    running = await boot();
    for (const args of [
      { name: 'a', base64: 'not base64!' },
      { name: 'a', base64: 'abc' },
      { name: 'a' },
      { name: 'a', text: 'x', base64: 'eA==' },
      { name: '', text: 'x' },
    ]) {
      const r = await call(KEYS.writer, 'upload_file', args);
      expect(r.isError).toBe(true);
      expect(text(r)).toMatch(/^Invalid input: /);
      expect(text(r)).not.toContain('not base64');
    }
    expect(running.holder.calls).toEqual([]);
  });

  it('refuses decoded content above MCP_MAX_UPLOAD_BYTES with a fixed error and stores nothing', async () => {
    running = await boot();
    const atCap = await call(KEYS.writer, 'upload_file', { name: 'a', base64: Buffer.alloc(CAP, 1).toString('base64') });
    expect(atCap.isError).toBeFalsy();
    running.holder.calls.length = 0;
    const overBase64 = await call(KEYS.writer, 'upload_file', { name: 'a', base64: Buffer.alloc(CAP + 1, 1).toString('base64') });
    const overText = await call(KEYS.writer, 'upload_file', { name: 'a', text: 'é'.repeat(CAP / 2 + 1) });
    for (const r of [overBase64, overText]) {
      expect(r.isError).toBe(true);
      expect(text(r)).toBe('Content is too large.');
    }
    expect(running.holder.calls).toEqual([]);
  });

  it('rejects a request body above the cap-derived limit before any tool runs', async () => {
    running = await boot();
    const res = await fetch(`${running.base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${KEYS.writer}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_file', arguments: { name: 'a', base64: 'A'.repeat(200_000) } } }),
    });
    expect(res.status).toBe(413);
    await res.text();
    expect(running.holder.calls).toEqual([]);
  });

  it('gives the same safe error as REST for a Collection of another scope, without echoing details', async () => {
    running = await boot();
    const r = await call(KEYS.writer, 'upload_file', { name: 'a.md', text: 'x', collectionId: 'foreign' });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe('Invalid request.');
    expect(JSON.stringify(r)).not.toContain('SENTINEL');
  });
});

describe('delete_file, remember, update_memory, forget', () => {
  it('deletes a file and forgets a memory in the key Workspace', async () => {
    running = await boot();
    expect((await call(KEYS.deleter, 'delete_file', { id: KNOWN_ID })).structuredContent).toEqual({ deleted: true, id: KNOWN_ID });
    expect((await call(KEYS.full, 'forget', { id: KNOWN_ID })).structuredContent).toEqual({ forgotten: true, id: KNOWN_ID });
    expect(running.holder.calls.map((c) => c.op)).toEqual(['remove', 'forget']);
  });

  it('answers foreign, random and malformed ids with one identical not-found error', async () => {
    running = await boot();
    for (const tool of ['delete_file', 'forget']) {
      const results = [];
      for (const id of [randomUUID(), 'nope', '../../etc/passwd']) results.push(text(await call(KEYS.full, tool, { id })));
      expect(new Set(results)).toEqual(new Set(['Not found.']));
    }
    const update = text(await call(KEYS.full, 'update_memory', { id: randomUUID(), type: 'fact', content: 'x', title: null, metadata: null, confidence: null, source: null, tags: [] }));
    expect(update).toBe('Not found.');
  });

  it('remember passes the client for provenance and the closed create schema; supersedes with a malformed id is not found', async () => {
    running = await boot();
    const { result: r } = await rawCall(KEYS.memWriter, 'remember', { type: 'decision', content: 'Use pg-boss', tags: ['Infra'], confidence: 0.8, supersedes: KNOWN_ID });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ type: 'decision', deduplicated: false, hints: [] });
    expect(r.content[0]!.text).toContain('RETRIEVED DATA BEGIN');
    const [input, client, scope] = lastCall().args as [Record<string, unknown>, unknown, unknown];
    expect(input).toMatchObject({ type: 'decision', content: 'Use pg-boss', tags: ['infra'], supersedes: KNOWN_ID });
    expect(client).toEqual({ name: 'agent-x', version: '9.1' });
    expect(scope).toEqual({ kind: 'workspace', workspaceId: WORKSPACE_ID });

    // Without client info in the call the provenance client is null; a key cannot forge it through the arguments.
    await call(KEYS.memWriter, 'remember', { type: 'fact', content: 'no client' });
    expect(lastCall().args[1]).toBeNull();
    expect(text(await call(KEYS.memWriter, 'remember', { type: 'fact', content: 'x', createdByKind: 'admin' }))).toBe('Invalid input: (unexpected field).');
    expect(text(await call(KEYS.memWriter, 'remember', { type: 'fact', content: 'x', clientName: 'forged' }))).toBe('Invalid input: (unexpected field).');
    expect(text(await call(KEYS.memWriter, 'remember', { type: 'nope', content: 'x' }))).toBe('Invalid input: type.');
    expect(text(await call(KEYS.memWriter, 'remember', { type: 'fact', content: 'x', supersedes: 'junk' }))).toBe('Not found.');
  });

  it('update_memory follows the REST PUT rules: every field required, null clears, extra fields rejected', async () => {
    running = await boot();
    const full = { id: KNOWN_ID, type: 'fact', content: 'new', title: null, metadata: null, confidence: null, source: null, tags: [] };
    const ok = await call(KEYS.memWriter, 'update_memory', full);
    expect(ok.isError).toBeFalsy();
    expect(lastCall()).toEqual({ op: 'update', args: [KNOWN_ID, { type: 'fact', content: 'new', title: null, metadata: null, confidence: null, source: null, tags: [] }] });

    for (const missing of ['title', 'metadata', 'confidence', 'source', 'tags', 'content', 'type']) {
      const { [missing]: _omitted, ...rest } = full as Record<string, unknown>;
      const r = await call(KEYS.memWriter, 'update_memory', rest);
      expect(r.isError).toBe(true);
      expect(text(r)).toBe(`Invalid input: ${missing}.`);
    }
    expect(text(await call(KEYS.memWriter, 'update_memory', { ...full, supersedes: KNOWN_ID }))).toBe('Invalid input: (unexpected field).');
    expect(text(await call(KEYS.memWriter, 'update_memory', { ...full, confidence: 2 }))).toBe('Invalid input: confidence.');
    expect(running.holder.calls.filter((c) => c.op === 'update')).toHaveLength(1);
  });

  it('never leaks service error text, stack traces or sentinels', async () => {
    running = await boot();
    const out = JSON.stringify([
      await call(KEYS.full, 'delete_file', { id: randomUUID() }),
      await call(KEYS.full, 'forget', { id: randomUUID() }),
      await call(KEYS.writer, 'upload_file', { name: 'a', text: 'x', collectionId: 'foreign' }),
    ]);
    expect(out).not.toMatch(/SENTINEL|stack|SELECT|\/etc/);
  });
});
