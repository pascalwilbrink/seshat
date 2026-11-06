import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MCP_TOOL_CATALOG, type Permission } from '@seshat/domain';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, describeIntegration } from './helpers/integration.js';

/**
 * End-to-end proof of the MCP surface (spec seshat-mcp-server, AC-1 to AC-8, AC-10): the real application (AppModule,
 * real PostgreSQL + pgvector, real pg-boss ingestion worker, real API keys) listens on a real port and is driven by the
 * official SDK client over Streamable HTTP. Only the embedding provider is replaced by the deterministic fake.
 */
vi.mock('../src/ingestion/ai-sdk-embedding.service.js', async () => {
  const { FakeEmbeddingService } = await import('../src/ingestion/fake-embedding.service.js');
  return { AiSdkEmbeddingService: class extends FakeEmbeddingService { constructor(_config?: unknown) { super(); } } };
});

const SENTINELS = {
  keyName: 'SENTINEL-KEYNAME-4f1a9c',
  foreignFile: 'SENTINEL-FOREIGNFILE-77be21',
  foreignMemory: 'SENTINEL-FOREIGNMEMORY-5d03aa',
  globalFile: 'SENTINEL-GLOBALFILE-c81e60',
  ownFile: 'SENTINEL-OWNFILE-90d2b7',
};
const UPLOAD_CAP = 4096;
const RESULT_CAP = 6000;

const READ: Permission[] = ['files:read', 'collections:read', 'memories:read', 'search'];
const READ_TOOLS = [
  'list_files', 'get_file', 'get_file_chunks', 'list_collections', 'list_tags',
  'search_knowledge', 'get_context', 'recall', 'list_memories', 'get_related_memories',
];
const WRITE_TOOLS = ['upload_file', 'remember', 'update_memory'];
const DELETE_TOOLS = ['delete_file', 'forget'];
const ALL_PERMISSIONS: Permission[] = ['files:read', 'files:write', 'files:delete', 'collections:read', 'collections:write', 'memories:read', 'memories:write', 'memories:delete', 'search', 'global:read'];

/** Everything a tool or the server said, so the leak scan at the end covers the whole run. */
const transcript: string[] = [];
/** Text an attacker-visible error could carry: stacks, SQL, paths, key material, connection strings. */
const LEAK_PATTERNS: RegExp[] = [
  /\bat\s+\S+\s+\(.*:\d+:\d+\)/, /node_modules/, /\bSELECT\b|\bINSERT\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i, /violates|duplicate key|relation "/i,
  /\/tmp\/|\/home\/|seshat-test-files|originals\/|\.tmp\//, /sk_seshat_/, /postgres(ql)?:\/\//, /QueryFailedError|TypeORMError|PayloadTooLargeException|NotFoundException/,
];

describeIntegration('MCP end to end: SDK client over Streamable HTTP against the real application', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let app: INestApplication;
  let base = '';
  let adminDb: PgClient;
  let appDbName = '';
  let adminCookie = '';
  let wsA: string;
  let wsB: string;
  const keys: Record<string, { id: string; secret: string }> = {};
  const clients: McpClient[] = [];
  const created: { fileA?: string; foreignFile?: string; foreignMemory?: string; globalFile?: string; globalMemory?: string } = {};

  const api = async (method: string, path: string, body?: unknown, form?: FormData) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { cookie: adminCookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  };
  const upload = async (path: string, name: string, content: string) => {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/markdown' }), name);
    const r = await api('POST', path, undefined, form);
    expect(r.status).toBe(201);
    return r.json.id as string;
  };
  async function makeKey(label: string, permissions: Permission[], name = label) {
    const r = await api('POST', `/workspaces/${wsA}/api-keys`, { name, permissions });
    expect(r.status).toBe(201);
    keys[label] = { id: r.json.apiKey.id, secret: r.json.secret };
  }

  const connect = async (secret: string) => {
    const client = new McpClient({ name: 'e2e-agent', version: '2.4.1' });
    clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${secret}` } } }));
    return client;
  };
  const listTools = async (label: string) => (await (await connect(keys[label]!.secret)).listTools()).tools;
  type Result = { isError?: boolean; content: { type: string; text: string }[]; structuredContent?: any };
  /** Calls a tool as `label`; protocol errors (unknown/unlisted tool) are returned as `{ protocolError }`. */
  async function call(label: string, name: string, args: Record<string, unknown> = {}): Promise<Result & { protocolError?: string; text: string }> {
    const client = await connect(keys[label]!.secret);
    try {
      const r = (await client.callTool({ name, arguments: args })) as Result;
      const text = r.content.map((c) => c.text).join('\n');
      transcript.push(text, JSON.stringify(r.structuredContent ?? null));
      return { ...r, text };
    } catch (err) {
      const message = (err as Error).message;
      transcript.push(message);
      return { content: [], text: message, protocolError: message };
    }
  }
  const ok = async (label: string, name: string, args: Record<string, unknown> = {}) => {
    const r = await call(label, name, args);
    expect(r.isError, `${name}: ${r.text}`).not.toBe(true);
    expect(r.protocolError).toBeUndefined();
    return r.structuredContent;
  };
  const rawMcp = (headers: Record<string, string>, body: unknown, method = 'POST') =>
    fetch(`${base}/mcp`, { method, headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers }, body: method === 'POST' ? JSON.stringify(body) : undefined });
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  async function waitIndexed(label: string, fileId: string) {
    for (let i = 0; i < 100; i++) {
      const f = await ok(label, 'get_file', { fileId });
      const status = f.ingestionStatus;
      if (status === 'indexed') return f;
      if (status === 'failed') throw new Error(`ingestion failed: ${f.ingestionError}`);
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('ingestion did not finish');
  }

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    // A dedicated database so pg-boss, the vector extension and migrations never touch other suites.
    appDbName = `seshat_mcp_e2e_test_${randomBytes(4).toString('hex')}`;
    adminDb = new PgClient({ connectionString: TEST_DATABASE_URL });
    await adminDb.connect();
    await adminDb.query(`CREATE DATABASE "${appDbName}"`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${appDbName}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('DB_MIGRATE_ON_START', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MCP_MAX_UPLOAD_BYTES', String(UPLOAD_CAP));
    vi.stubEnv('MCP_MAX_RESULT_CHARS', String(RESULT_CAP));
    vi.stubEnv('INGESTION_CONCURRENCY', '2');

    // TypeORM would load entity files from the glob with native import(), which cannot read TypeScript under Vitest; the
    // entity classes are handed over explicitly instead (same options otherwise, same migrations).
    vi.doMock('../src/database/data-source.js', async () => {
      const { DataSource } = await import('typeorm');
      const { createDataSourceOptions } = await import('../src/database/options.js');
      const modules = import.meta.glob('../src/**/*.entity.ts', { eager: true }) as Record<string, Record<string, unknown>>;
      const entities = Object.values(modules).flatMap((m) => Object.values(m).filter((v): v is Function => typeof v === 'function'));
      return { createDataSourceOptions, dataSource: new DataSource({ ...createDataSourceOptions({ databaseUrl: url.toString() }), entities }) };
    });
    // Imported only now: the config and data source read the environment when their modules load.
    const { createApp } = await import('../src/app.setup.js');
    const { AppModule } = await import('../src/app.module.js');
    const { getAppConfig } = await import('../src/config/index.js');
    app = await createApp(AppModule, getAppConfig(), false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    adminCookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;

    wsA = (await api('POST', '/global/workspaces', { name: 'Alpha', slug: 'alpha' })).json.id;
    wsB = (await api('POST', '/global/workspaces', { name: 'Bravo', slug: 'bravo' })).json.id;

    await makeKey('read', READ, SENTINELS.keyName);
    await makeKey('rw', [...READ, 'files:write', 'memories:write', 'collections:write']);
    await makeKey('global', [...READ, 'global:read']);
    await makeKey('full', ALL_PERMISSIONS);
    await makeKey('noSearch', ['files:read', 'memories:read']);
    await makeKey('filesOnly', ['files:read', 'search']);
    await makeKey('writeOnly', ['files:write', 'memories:write']);
    await makeKey('revoked', READ);
    await makeKey('expired', READ);
    expect((await api('POST', `/workspaces/${wsA}/api-keys/${keys.revoked!.id}/revoke`)).status).toBe(200);
    // The API refuses past expiry dates, so the key is aged in the database.
    const dbUrl = new URL(url.toString());
    const appDb = new PgClient({ connectionString: dbUrl.toString() });
    await appDb.connect();
    await appDb.query('UPDATE api_keys SET expires_at = now() - interval \'1 hour\' WHERE id = $1', [keys.expired!.id]);
    await appDb.end();

    // Foreign (Workspace B) and Global data, created by the admin.
    created.foreignFile = await upload(`/workspaces/${wsB}/files`, 'bravo-secret.md', `# Bravo\n${SENTINELS.foreignFile} private to bravo`);
    created.foreignMemory = (await api('POST', `/workspaces/${wsB}/memories`, { type: 'fact', content: `${SENTINELS.foreignMemory} bravo fact` })).json.id;
    created.globalFile = await upload('/global/files', 'global-handbook.md', `# Handbook\n${SENTINELS.globalFile} shared glossary entry about quokkas`);
    created.globalMemory = (await api('POST', '/global/memories', { type: 'fact', content: 'Global quokka fact for everyone' })).json.id;
  }, 120_000);

  afterAll(async () => {
    for (const c of clients) await c.close().catch(() => undefined);
    await app?.close();
    if (adminDb) {
      await adminDb.query(`DROP DATABASE IF EXISTS "${appDbName}" WITH (FORCE)`).catch(() => undefined);
      await adminDb.end();
    }
    vi.unstubAllEnvs();
  }, 60_000);

  describe('initialize and tools/list per key', () => {
    const summary = (tools: Awaited<ReturnType<typeof listTools>>) => Object.fromEntries(tools.map((t) => [t.name, t.annotations]));

    it('initializes as the "seshat" server over stateless Streamable HTTP', async () => {
      const client = await connect(keys.read!.secret);
      expect(client.getServerVersion()?.name).toBe('seshat');
      expect(client.getServerCapabilities()?.tools).toBeDefined();
      const res = await rawMcp({ authorization: `Bearer ${keys.read!.secret}` }, rpc);
      expect(res.status).toBe(200);
      expect(res.headers.get('mcp-session-id')).toBeNull();
    });

    it('a read-only key sees exactly the read tools, all annotated readOnlyHint', async () => {
      const tools = await listTools('read');
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
      for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    });

    it('a read-and-write key adds exactly upload_file, remember and update_memory, annotated readOnlyHint false', async () => {
      const tools = await listTools('rw');
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());
      const annotations = summary(tools);
      for (const n of WRITE_TOOLS) expect(annotations[n]).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      for (const n of READ_TOOLS) expect(annotations[n]).toMatchObject({ readOnlyHint: true });
    });

    it('the Global grant changes reach, not the tool set', async () => {
      const tools = await listTools('global');
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS].sort());
    });

    it('a full key sees all 15 tools; delete_file and forget are destructive, the rest follow the catalog', async () => {
      const tools = await listTools('full');
      expect(tools.map((t) => t.name).sort()).toEqual([...READ_TOOLS, ...WRITE_TOOLS, ...DELETE_TOOLS].sort());
      expect(tools).toHaveLength(Object.keys(MCP_TOOL_CATALOG).length);
      const annotations = summary(tools);
      for (const n of DELETE_TOOLS) expect(annotations[n]).toMatchObject({ destructiveHint: true, readOnlyHint: false });
      for (const t of tools) {
        expect(t.description?.length).toBeGreaterThan(20);
        expect(t.inputSchema.type).toBe('object');
      }
    });

    it('lists only what the permissions allow for partial keys', async () => {
      expect((await listTools('noSearch')).map((t) => t.name).sort()).toEqual(['get_file', 'get_file_chunks', 'list_files', 'list_memories', 'list_tags']);
      expect((await listTools('filesOnly')).map((t) => t.name).sort()).toEqual(['get_context', 'get_file', 'get_file_chunks', 'list_files', 'list_tags', 'search_knowledge']);
      expect((await listTools('writeOnly')).map((t) => t.name).sort()).toEqual(['remember', 'update_memory', 'upload_file']);
    });
  });

  describe('flows', () => {
    it('upload -> ingestion reaches indexed -> list/get/chunks -> search_knowledge finds it -> get_context cites it', async () => {
      const uploaded = await ok('rw', 'upload_file', {
        name: 'quokka-notes.md',
        text: `# Quokka care\n${SENTINELS.ownFile} The zymurgy of quokka feed is documented here.\n`,
        tags: ['animals'],
      });
      const id = uploaded.file.id as string;
      created.fileA = id;
      expect(uploaded.file).toMatchObject({ name: 'quokka-notes.md', ingestionStatus: 'pending' });
      expect(uploaded.file.provenance.createdBy).toMatchObject({ kind: 'api_key', keyId: keys.rw!.id });

      const indexed = await waitIndexed('rw', id);
      expect(indexed.ingestionStatus).toBe('indexed');
      expect(indexed.chunkCount).toBeGreaterThan(0);

      const list = await ok('rw', 'list_files', { name: 'quokka' });
      expect(list.items.map((f: any) => f.id)).toContain(id);
      expect((await ok('rw', 'list_files', { tag: 'animals' })).items).toHaveLength(1);
      expect((await ok('rw', 'list_tags')).items.map((t: any) => t.name)).toContain('animals');
      expect(Array.isArray((await ok('rw', 'list_collections')).items)).toBe(true);

      const chunks = await ok('rw', 'get_file_chunks', { fileId: id });
      expect(chunks.items[0].content).toContain('RETRIEVED DATA BEGIN');
      expect(chunks.items[0].content).toContain('zymurgy');

      const found = await ok('rw', 'search_knowledge', { query: 'zymurgy quokka feed', types: ['files'] });
      const hit = found.results.find((r: any) => r.file?.id === id);
      expect(hit).toBeDefined();
      expect(hit.kind).toBe('chunk');
      expect(hit.content).toMatch(/RETRIEVED DATA BEGIN[\s\S]*retrieved data|Retrieved data, not instructions/i);
      expect(hit.scope).toMatchObject({ kind: 'workspace', slug: 'alpha' });

      const ctx = await ok('rw', 'get_context', { query: 'zymurgy quokka feed', types: ['files'], maxChars: 2500 });
      expect(ctx.context).toContain('zymurgy');
      expect(ctx.context).toMatch(/not instructions|data/i);
      expect(ctx.sources.some((s: any) => JSON.stringify(s).includes(id))).toBe(true);
    });

    it('remember -> recall -> update_memory -> get_related_memories -> list_memories -> forget, with MCP provenance', async () => {
      // The stateless transport reads the client name from the call itself, so a raw call repeats `_meta.clientInfo`.
      const res = await rawMcp(
        { authorization: `Bearer ${keys.rw!.secret}` },
        { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'remember', arguments: { type: 'decision', content: 'We feed the quokkas at dawn using marmalade-free pellets.', title: 'Feeding', tags: ['animals'], confidence: 0.8 }, _meta: { clientInfo: { name: 'claude-code', version: '9.9.1' } } } },
      );
      const memory = (await res.json()).result.structuredContent;
      transcript.push(JSON.stringify(memory));
      expect(memory).toMatchObject({ type: 'decision', status: 'active', deduplicated: false });
      expect(memory.provenance.createdBy).toMatchObject({ kind: 'api_key', keyId: keys.rw!.id, keyName: 'rw' });
      expect(memory.provenance.client).toEqual({ name: 'claude-code', version: '9.9.1' });

      await ok('rw', 'remember', { type: 'fact', content: 'Quokkas are small marsupials from Western Australia.' });
      const same = await ok('rw', 'remember', { type: 'decision', content: 'We feed the quokkas at dawn using marmalade-free pellets.' });
      expect(same.deduplicated).toBe(true);
      expect(same.id).toBe(memory.id);

      await new Promise((r) => setTimeout(r, 500));
      const recalled = await ok('rw', 'recall', { query: 'quokkas dawn pellets' });
      const m = recalled.results.find((r: any) => r.id === memory.id);
      expect(m).toBeDefined();
      expect(m.kind).toBe('memory');
      expect(m.content).toContain('RETRIEVED DATA BEGIN');

      const updated = await ok('rw', 'update_memory', {
        id: memory.id, type: 'decision', content: 'We feed the quokkas at dusk using pellets.', title: null, metadata: null, confidence: null, source: null, tags: ['animals', 'schedule'],
      });
      expect(updated).toMatchObject({ id: memory.id, title: null });
      expect(updated.tags.sort()).toEqual(['animals', 'schedule']);

      const related = await ok('rw', 'get_related_memories', { memoryId: memory.id });
      expect(Array.isArray(related.results)).toBe(true);
      expect(related.results.map((r: any) => r.id)).not.toContain(memory.id);

      const listed = await ok('rw', 'list_memories', { type: 'decision' });
      expect(listed.items.find((i: any) => i.id === memory.id).content).toContain('dusk');

      // Forget needs memories:delete, which the rw key does not hold: it is neither listed nor callable.
      expect((await call('rw', 'forget', { id: memory.id })).protocolError).toMatch(/Unknown tool/);
      expect(await ok('full', 'forget', { id: memory.id })).toEqual({ forgotten: true, id: memory.id });
      expect((await ok('rw', 'recall', { query: 'quokkas dusk pellets' })).results.map((r: any) => r.id)).not.toContain(memory.id);
      expect((await call('full', 'forget', { id: memory.id })).text).toBe('Not found.');
    });

    it('upload_file accepts base64 and delete_file removes the file and its chunks', async () => {
      const b64 = Buffer.from('# Temp\nshort lived zephyrnote\n').toString('base64');
      const up = await ok('full', 'upload_file', { name: 'temp.md', base64: b64 });
      await waitIndexed('full', up.file.id);
      expect(await ok('full', 'delete_file', { id: up.file.id })).toEqual({ deleted: true, id: up.file.id });
      expect((await call('full', 'get_file', { fileId: up.file.id })).text).toBe('Not found.');
      expect((await call('full', 'get_file_chunks', { fileId: up.file.id })).text).toBe('Not found.');
      const found = await ok('full', 'search_knowledge', { query: 'zephyrnote' });
      expect(found.results.filter((r: any) => r.file?.id === up.file.id)).toEqual([]);
    });

    it('the Global grant reads Global files and memories; without it Global is refused', async () => {
      const list = await ok('global', 'list_files', { scope: 'global' });
      expect(list.items.map((f: any) => f.id)).toContain(created.globalFile);
      await waitIndexed('global', created.globalFile!).catch(() => undefined);
      expect((await ok('global', 'list_memories', { scope: 'global' })).items.map((m: any) => m.id)).toContain(created.globalMemory);
      const found = await ok('global', 'search_knowledge', { query: 'quokka', includeGlobal: true });
      expect(found.results.some((r: any) => r.scope?.kind === 'global')).toBe(true);
      const without = await ok('global', 'search_knowledge', { query: 'quokka' });
      expect(without.results.every((r: any) => r.scope?.kind === 'workspace')).toBe(true);

      // Reading Global directly answers like a missing resource; asking a search to include it names the missing grant.
      expect(await call('read', 'list_files', { scope: 'global' })).toMatchObject({ isError: true, text: 'Not found.' });
      expect(await call('read', 'search_knowledge', { query: 'quokka', includeGlobal: true })).toMatchObject({ isError: true, text: 'Missing permission: global:read.' });
    });
  });

  describe('permissions are enforced on every call, even when called directly', () => {
    it('an unlisted tool fails exactly like an unknown one', async () => {
      const unknown = await call('read', 'no_such_tool', {});
      for (const [label, name] of [['read', 'upload_file'], ['read', 'delete_file'], ['read', 'remember'], ['read', 'forget'], ['rw', 'delete_file'], ['writeOnly', 'search_knowledge'], ['noSearch', 'recall']] as const) {
        const r = await call(label, name, { name: 'x.md', text: 'x', id: randomUUID(), query: 'x' });
        expect(r.protocolError, `${label}/${name}`).toBe(unknown.protocolError);
        expect(r.isError).toBeUndefined();
      }
      expect(unknown.protocolError).toMatch(/Unknown tool/);
    });

    it('a listed tool still checks the permissions of the requested types, and ungranted Global looks like a missing resource', async () => {
      const r = await call('filesOnly', 'search_knowledge', { query: 'quokka', types: ['memories'] });
      expect(r.isError).toBe(true);
      expect(r.text).toBe('Missing permission: memories:read.');
      const r2 = await call('read', 'list_files', { scope: 'global' });
      expect(r2.text).toBe('Not found.');
    });

    it('a read tool cannot be used to reach the database through a direct HTTP call either (no session, no key)', async () => {
      const res = await rawMcp({}, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: {} } });
      expect(res.status).toBe(401);
    });
  });

  describe('isolation: ids of another Workspace answer exactly like random ids', () => {
    it('get_file, get_file_chunks, delete_file, update_memory, forget and get_related_memories', async () => {
      const upd = (id: string) => ({ id, type: 'fact', content: 'tampered', title: null, metadata: null, confidence: null, source: null, tags: [] });
      const cases: [string, (id: string) => Record<string, unknown>, 'file' | 'memory'][] = [
        ['get_file', (id) => ({ fileId: id }), 'file'],
        ['get_file_chunks', (id) => ({ fileId: id }), 'file'],
        ['delete_file', (id) => ({ id }), 'file'],
        ['update_memory', upd, 'memory'],
        ['forget', (id) => ({ id }), 'memory'],
        ['get_related_memories', (id) => ({ memoryId: id }), 'memory'],
      ];
      for (const [tool, args, kind] of cases) {
        const foreign = kind === 'file' ? created.foreignFile! : created.foreignMemory!;
        const real = await call('full', tool, args(foreign));
        const random = await call('full', tool, args(randomUUID()));
        const malformed = await call('full', tool, args('not-a-uuid'));
        expect(real.isError, tool).toBe(true);
        expect(real.text, tool).toBe('Not found.');
        expect(random.text, tool).toBe(real.text);
        expect(malformed.text, tool).toBe(real.text);
        expect(JSON.stringify(real.content)).toBe(JSON.stringify(random.content));
        expect(real.text).not.toContain(foreign);
      }
      // The foreign data survived the attempted delete, update and forget.
      expect((await api('GET', `/workspaces/${wsB}/files/${created.foreignFile}`)).status).toBe(200);
      expect((await api('GET', `/workspaces/${wsB}/memories/${created.foreignMemory}`)).json.content).toContain(SENTINELS.foreignMemory);
    });

    it('search never returns another Workspace\'s content', async () => {
      await waitIndexed('full', created.fileA!);
      for (const query of ['SENTINEL-FOREIGNFILE-77be21', 'SENTINEL-FOREIGNMEMORY-5d03aa', 'bravo private']) {
        const r = await ok('full', 'search_knowledge', { query, includeGlobal: true });
        expect(JSON.stringify(r)).not.toMatch(/FOREIGN/);
      }
    });
  });

  describe('writes to Global are impossible', () => {
    it('upload_file, remember and update_memory reject scope and Global options', async () => {
      const before = (await api('GET', '/global/files')).json.items.length;
      const memBefore = (await api('GET', '/global/memories')).json.items.length;
      for (const [tool, args] of [
        ['upload_file', { name: 'g.md', text: 'x', scope: 'global' }],
        ['upload_file', { name: 'g.md', text: 'x', includeGlobal: true }],
        ['remember', { type: 'fact', content: 'global write', scope: 'global' }],
        ['update_memory', { id: created.globalMemory, type: 'fact', content: 'x', title: null, metadata: null, confidence: null, source: null, tags: [], scope: 'global' }],
      ] as const) {
        const r = await call('full', tool, args);
        expect(r.isError, tool).toBe(true);
        expect(r.text).toBe('Invalid input: (unexpected field).');
      }
      // Global ids are not reachable by writing tools either: same not-found as any foreign id.
      expect((await call('full', 'delete_file', { id: created.globalFile })).text).toBe('Not found.');
      expect((await call('full', 'forget', { id: created.globalMemory })).text).toBe('Not found.');
      expect((await api('GET', '/global/files')).json.items).toHaveLength(before);
      expect((await api('GET', '/global/memories')).json.items).toHaveLength(memBefore);
      expect((await api('GET', `/global/memories/${created.globalMemory}`)).json.content).toBe('Global quokka fact for everyone');
    });
  });

  describe('caps and validation', () => {
    it('refuses uploads above MCP_MAX_UPLOAD_BYTES (text and base64) and stores nothing', async () => {
      const before = (await ok('full', 'list_files', { name: 'toolarge' })).items.length;
      const text = await call('full', 'upload_file', { name: 'toolarge.md', text: 'a'.repeat(UPLOAD_CAP + 1) });
      expect(text).toMatchObject({ isError: true, text: 'Content is too large.' });
      const b64 = await call('full', 'upload_file', { name: 'toolarge2.md', base64: Buffer.alloc(UPLOAD_CAP + 1, 97).toString('base64') });
      expect(b64).toMatchObject({ isError: true, text: 'Content is too large.' });
      const exact = await ok('full', 'upload_file', { name: 'exact-cap.md', text: 'b'.repeat(UPLOAD_CAP) });
      expect(exact.file.sizeBytes).toBe(UPLOAD_CAP);
      expect((await ok('full', 'list_files', { name: 'toolarge' })).items).toHaveLength(before);
    });

    it('limits the HTTP body of /mcp calls too (413, no echo)', async () => {
      const res = await rawMcp({ authorization: `Bearer ${keys.full!.secret}` }, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'upload_file', arguments: { name: 'a.md', base64: 'QUJD'.repeat(60_000) } } });
      expect(res.status).toBe(413);
      expect(await res.text()).not.toContain('QUJD');
    });

    it('answers validation errors with field names only', async () => {
      const cases: [string, Record<string, unknown>, string][] = [
        ['search_knowledge', {}, 'Invalid input: query.'],
        ['search_knowledge', { query: 'x', limit: 9999 }, 'Invalid input: limit.'],
        ['search_knowledge', { query: 'x', surprise: SENTINELS.foreignFile }, 'Invalid input: (unexpected field).'],
        ['list_files', { limit: 'many' }, 'Invalid input: limit.'],
        ['remember', { type: 'opinion', content: '' }, 'Invalid input: type, content.'],
        ['upload_file', { name: 'x.md' }, 'Invalid input: text.'],
        ['upload_file', { name: 'x.md', text: 'a', base64: 'YQ==' }, 'Invalid input: text.'],
        ['upload_file', { name: 'x.md', base64: '%%%not base64%%%' }, 'Invalid input: base64.'],
      ];
      for (const [tool, args, message] of cases) {
        const r = await call('full', tool, args);
        expect(r.isError, tool).toBe(true);
        expect(r.text, tool).toBe(message);
      }
    });

    it('caps results at MCP_MAX_RESULT_CHARS with a truncation note', async () => {
      await ok('full', 'remember', { type: 'context', content: `bigmemory ${'word '.repeat(1800)}` });
      const r = await call('full', 'list_memories', { text: 'bigmemory' });
      expect(r.isError).not.toBe(true);
      expect(r.text.length).toBeLessThanOrEqual(RESULT_CAP);
      expect(r.text).toContain('Result truncated');
      expect(r.structuredContent).toMatchObject({ truncated: true });
      const ctx = await ok('full', 'get_context', { query: 'bigmemory word', types: ['memories'], maxChars: 1500 });
      expect(ctx.context.length).toBeLessThanOrEqual(1500);
    });
  });

  describe('authentication', () => {
    const expect401 = async (res: Response) => {
      const text = await res.text();
      transcript.push(text);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe('Bearer');
      return text;
    };

    it('answers 401 with WWW-Authenticate for missing, malformed, unknown, revoked and expired keys, with one generic body', async () => {
      const unknownKey = `sk_seshat_${'a'.repeat(8)}_${'b'.repeat(43)}`;
      const bodies = [
        await expect401(await rawMcp({}, rpc)),
        await expect401(await rawMcp({ authorization: 'Bearer nonsense' }, rpc)),
        await expect401(await rawMcp({ authorization: `Bearer ${unknownKey}` }, rpc)),
        await expect401(await rawMcp({ authorization: `Bearer ${keys.revoked!.secret}` }, rpc)),
        await expect401(await rawMcp({ authorization: `Bearer ${keys.expired!.secret}` }, rpc)),
      ];
      expect(new Set(bodies).size).toBe(1);
      // The SDK client fails to connect with such a key.
      const client = new McpClient({ name: 'e2e', version: '1' });
      clients.push(client);
      await expect(client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${keys.revoked!.secret}` } } }))).rejects.toThrow();
    });

    it('rejects the admin session cookie, alone or together with a valid key', async () => {
      await expect401(await rawMcp({ cookie: adminCookie }, rpc));
      await expect401(await rawMcp({ cookie: adminCookie, authorization: `Bearer ${keys.full!.secret}` }, rpc));
    });

    it('serves only POST: GET and DELETE answer 405 for a valid key', async () => {
      expect((await rawMcp({ authorization: `Bearer ${keys.full!.secret}` }, null, 'GET')).status).toBe(405);
      expect((await rawMcp({ authorization: `Bearer ${keys.full!.secret}` }, null, 'DELETE')).status).toBe(405);
    });

    it('a revoked key stops working at once, also for a key that worked before', async () => {
      await makeKey('shortLived', READ);
      expect((await ok('shortLived', 'list_files')).items).toBeDefined();
      expect((await api('POST', `/workspaces/${wsA}/api-keys/${keys.shortLived!.id}/revoke`)).status).toBe(200);
      await expect401(await rawMcp({ authorization: `Bearer ${keys.shortLived!.secret}` }, rpc));
    });
  });

  describe('no leaks', () => {
    it('keeps sentinels, stack traces, SQL, paths and keys out of every MCP response and tool error', async () => {
      // Provoke internal-looking failures on top of everything the suite already collected.
      await call('read', 'get_file', { fileId: created.foreignFile });
      await call('read', 'search_knowledge', { query: "'; DROP TABLE files; --" });
      await call('full', 'list_files', { collectionId: randomUUID() });
      await call('full', 'list_files', { cursor: 'zzz-not-a-cursor' });
      await call('full', 'get_file_chunks', { fileId: created.fileA, cursor: '99999999999' });
      await call('read', 'list_memories', { text: '%_\\' });
      await call('read', 'search_knowledge', { query: 'x'.repeat(5000) });

      const all = transcript.join('\n');
      expect(all.length).toBeGreaterThan(1000);
      // Planted in a key name: the key is only ever shown by name where the API deliberately shows provenance, never in errors.
      for (const s of [SENTINELS.keyName, SENTINELS.foreignFile, SENTINELS.foreignMemory]) expect(all, s).not.toContain(s);
      for (const re of LEAK_PATTERNS) expect(all, String(re)).not.toMatch(re);
      for (const { secret } of Object.values(keys)) expect(all).not.toContain(secret);
      expect(all).not.toContain(adminCookie.split('=')[1]!);
    });

    it('does not echo the own-file sentinel in any error response', async () => {
      const errors = transcript.filter((t) => /^(Not found|Invalid|Missing|Content is|Forbidden|Internal|Conflict)/.test(t));
      expect(errors.length).toBeGreaterThan(10);
      for (const e of errors) expect(e).not.toContain(SENTINELS.ownFile);
      expect(errors).not.toContain('Internal error.');
    });
  });
});
