import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Permission } from '@seshat/domain';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TEST_ADMIN_PASSWORD, TEST_ADMIN_USERNAME } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, describeIntegration } from './helpers/integration.js';

/**
 * Usage insights, spec seshat-usage-insights AC-1 to AC-8: the real application (real PostgreSQL + pgvector, real
 * recorder, real API keys) is driven over HTTP and with the official MCP SDK client, then every usage table, every
 * captured log line and every usage/history response is scanned for planted sentinels. Domain content may appear only
 * in its ordinary, explicitly requested domain result, never in anything the analytics observer wrote or serves.
 */
vi.mock('../src/ingestion/ai-sdk-embedding.service.js', async () => {
  const { FakeEmbeddingService } = await import('../src/ingestion/fake-embedding.service.js');
  return { AiSdkEmbeddingService: class extends FakeEmbeddingService { constructor(_config?: unknown) { super(); } } };
});

const S = {
  query: 'SENTINEL-QUERY-a1f3c9',
  fileContent: 'SENTINEL-FILECONTENT-b27d40',
  memContent: 'SENTINEL-MEMCONTENT-c93e15',
  title: 'SENTINEL-TITLE-d04a77',
  metadata: 'SENTINEL-METADATA-e58b21',
  tag: 'sentinel-tag-f60c88',
  driver: 'SENTINEL-DRIVER-0a9e33',
  bad: 'SENTINEL-BADARG-19b4d2',
};
const ALL_SENTINELS = Object.values(S);
const ALL: Permission[] = ['files:read', 'files:write', 'files:delete', 'collections:read', 'collections:write', 'memories:read', 'memories:write', 'memories:delete', 'search', 'global:read'];

describeIntegration('usage insights: counting, privacy and security end to end', () => {
  vi.setConfig({ testTimeout: 60_000 });
  let app: INestApplication;
  let base = '';
  let adminDb: PgClient;
  let appDb: PgClient;
  let appDbName = '';
  let cookie = '';
  let wsA: string;
  let wsB: string;
  let key: { id: string; secret: string };
  let readKey: { id: string; secret: string };
  let fileId: string;
  let foreignFileId: string;
  let memoryId: string;
  const clients: McpClient[] = [];
  const logs: string[] = [];
  const restores: Array<() => void> = [];

  const api = async (method: string, path: string, body?: unknown, form?: FormData, auth: Record<string, string> = { cookie }) => {
    const res = await fetch(`${base}/api${path}`, {
      method,
      headers: { ...auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
    const text = await res.text();
    return { status: res.status, text, json: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : null };
  };
  const bearer = (k: { secret: string }) => ({ authorization: `Bearer ${k.secret}` });
  const upload = async (path: string, name: string, content: string) => {
    const form = new FormData();
    form.append('file', new Blob([content], { type: 'text/markdown' }), name);
    const r = await api('POST', path, undefined, form);
    expect(r.status).toBe(201);
    return r.json.id as string;
  };
  const connect = async (k: { secret: string }) => {
    const c = new McpClient({ name: 'privacy-agent', version: '1.0.0' });
    clients.push(c);
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: bearer(k) } }));
    return c;
  };
  const tool = async (c: McpClient, name: string, args: Record<string, unknown> = {}) => {
    try { return await c.callTool({ name, arguments: args }); } catch (e) { return { thrown: (e as Error).message }; }
  };
  const flush = async () => {
    const { UsageRecorderService } = await import('../src/usage/usage-recorder.service.js');
    await app.get(UsageRecorderService).flush();
  };
  const q = async (sql: string, params: unknown[] = []) => (await appDb.query(sql, params)).rows as Record<string, any>[];
  async function waitIndexed(id: string) {
    for (let i = 0; i < 100; i++) {
      const f = await api('GET', `/workspaces/${wsA}/files/${id}`);
      if (f.json?.ingestionStatus === 'indexed') return;
      if (f.json?.ingestionStatus === 'failed') throw new Error('ingestion failed');
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error('ingestion did not finish');
  }
  const fileTotals = async (id: string) => (await q('SELECT * FROM file_usage_totals WHERE file_id = $1', [id]))[0];
  const memTotals = async (id: string) => (await q('SELECT * FROM memory_usage_totals WHERE memory_id = $1', [id]))[0];
  /** Everything the usage feature persisted, as one searchable string. */
  async function dumpUsageTables(): Promise<string> {
    const tables = ['file_usage_daily', 'memory_usage_daily', 'file_usage_totals', 'memory_usage_totals', 'mcp_calls', 'mcp_call_resources', 'mcp_list_daily', 'usage_batches'];
    const out: string[] = [];
    for (const t of tables) out.push(t, JSON.stringify((await appDb.query(`SELECT * FROM ${t}`)).rows));
    return out.join('\n');
  }

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    appDbName = `seshat_usage_privacy_test_${randomBytes(4).toString('hex')}`;
    adminDb = new PgClient({ connectionString: TEST_DATABASE_URL });
    await adminDb.connect();
    await adminDb.query(`CREATE DATABASE "${appDbName}"`);
    const url = new URL(TEST_DATABASE_URL!);
    url.pathname = `/${appDbName}`;
    vi.stubEnv('DATABASE_URL', url.toString());
    vi.stubEnv('DB_MIGRATE_ON_START', 'true');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('MCP_MAX_RESULT_CHARS', '3000');
    vi.doMock('../src/database/data-source.js', async () => {
      const { DataSource } = await import('typeorm');
      const { createDataSourceOptions } = await import('../src/database/options.js');
      const modules = import.meta.glob('../src/**/*.entity.ts', { eager: true }) as Record<string, Record<string, unknown>>;
      const entities = Object.values(modules).flatMap((m) => Object.values(m).filter((v): v is Function => typeof v === 'function'));
      return { createDataSourceOptions, dataSource: new DataSource({ ...createDataSourceOptions({ databaseUrl: url.toString() }), entities }) };
    });

    // Capture every log line (Nest logger, console and raw stdout/stderr) from before the app starts.
    for (const stream of [process.stdout, process.stderr]) {
      const orig = stream.write.bind(stream);
      (stream as any).write = (chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return (orig as any)(chunk, ...rest); };
      restores.push(() => { (stream as any).write = orig; });
    }
    for (const m of ['log', 'warn', 'error', 'debug', 'info'] as const) {
      const orig = console[m];
      console[m] = (...a: unknown[]) => { logs.push(a.map(String).join(' ')); };
      restores.push(() => { console[m] = orig; });
    }

    const { createApp } = await import('../src/app.setup.js');
    const { AppModule } = await import('../src/app.module.js');
    const { getAppConfig } = await import('../src/config/index.js');
    app = await createApp(AppModule, getAppConfig(), false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    appDb = new PgClient({ connectionString: url.toString() });
    await appDb.connect();

    const login = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: TEST_ADMIN_USERNAME, password: TEST_ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
    wsA = (await api('POST', '/global/workspaces', { name: 'Alpha', slug: 'alpha' })).json.id;
    wsB = (await api('POST', '/global/workspaces', { name: 'Bravo', slug: 'bravo' })).json.id;
    const mk = async (name: string, permissions: Permission[]) => {
      const r = await api('POST', `/workspaces/${wsA}/api-keys`, { name, permissions });
      expect(r.status).toBe(201);
      return { id: r.json.apiKey.id as string, secret: r.json.secret as string };
    };
    key = await mk('privacy-full', ALL);
    readKey = await mk('privacy-read', ['files:read', 'memories:read', 'search']);

    // A multi-chunk file (the sentinel repeats so several chunks match) and a memory with every free-text field.
    const para = `${S.fileContent} quokka paragraph about marmalade pellets and sunrise feeding schedules. `.repeat(12);
    fileId = await upload(`/workspaces/${wsA}/files`, 'quokka.md', Array.from({ length: 8 }, (_, i) => `# Part ${i}\n\n${para}`).join('\n\n'));
    foreignFileId = await upload(`/workspaces/${wsB}/files`, 'bravo.md', `# Bravo\n${S.fileContent} foreign`);
    await waitIndexed(fileId);
    const m = await api('POST', `/workspaces/${wsA}/memories`, {
      type: 'fact', content: `${S.memContent} quokkas like pellets`, title: S.title, metadata: { note: S.metadata }, tags: [S.tag],
    });
    expect(m.status).toBe(201);
    memoryId = m.json.id;
    await flush();
    await appDb.query('TRUNCATE file_usage_daily, memory_usage_daily, file_usage_totals, memory_usage_totals, mcp_calls, mcp_call_resources, mcp_list_daily, usage_batches CASCADE');
  }, 120_000);

  afterAll(async () => {
    for (const r of restores.splice(0)) r();
    for (const c of clients) await c.close().catch(() => undefined);
    await app?.close();
    await appDb?.end().catch(() => undefined);
    if (adminDb) {
      await adminDb.query(`DROP DATABASE IF EXISTS "${appDbName}" WITH (FORCE)`).catch(() => undefined);
      await adminDb.end();
    }
    vi.unstubAllEnvs();
  }, 60_000);

  describe('counting rules and the request path (AC-1, AC-2)', () => {
    it('writes nothing to the database while the request is served and counts only after the flush', async () => {
      const { UsagePersistenceService } = await import('../src/usage/usage-persistence.service.js');
      const persist = vi.spyOn(app.get(UsagePersistenceService), 'persistBatch');
      await flush();
      persist.mockClear();
      const r = await api('GET', `/workspaces/${wsA}/files/${fileId}`);
      expect(r.status).toBe(200);
      expect(persist).not.toHaveBeenCalled();
      expect(await fileTotals(fileId)).toBeUndefined();
      await flush();
      expect(persist).toHaveBeenCalledTimes(1);
      expect(await fileTotals(fileId)).toMatchObject({ total_count: '1', read_count: '1', ui_count: '1', api_count: '0', mcp_count: '0' });
      persist.mockRestore();
    });

    it('counts a File once per request however many chunks are returned, with the channel of the caller', async () => {
      const before = Number((await fileTotals(fileId))!.retrieved_count);
      const res = await api('POST', `/workspaces/${wsA}/search`, { query: S.query + ' ' + S.fileContent, types: ['files'], limit: 20 }, undefined, bearer(key));
      expect(res.status).toBe(200);
      expect(res.json.results.filter((x: any) => x.kind === 'chunk').length).toBeGreaterThan(1);
      await flush();
      const t = (await fileTotals(fileId))!;
      expect(Number(t.retrieved_count)).toBe(before + 1);
      expect(Number(t.api_count)).toBe(1);
    });

    it('does not count lists, writes, denied, failed or foreign requests', async () => {
      const t0 = JSON.stringify([await fileTotals(fileId), await memTotals(memoryId)]);
      await api('GET', `/workspaces/${wsA}/files`);
      await api('GET', `/workspaces/${wsA}/memories`);
      await api('PUT', `/workspaces/${wsA}/files/${fileId}`, { name: 'quokka.md', collectionId: null, tags: [S.tag] });
      await api('GET', `/workspaces/${wsA}/files/${foreignFileId}`);
      await api('GET', `/workspaces/${wsB}/files/${fileId}`);
      await api('GET', `/workspaces/${wsA}/files/${randomUUID()}`);
      await api('GET', `/workspaces/${wsA}/files/${fileId}`, undefined, undefined, { authorization: 'Bearer sk_seshat_Nope0000_x0123456789abcdefghijklmnopqrstuvwxyz' });
      await api('GET', `/workspaces/${wsA}/files/${fileId}`, undefined, undefined, bearer(readKey)).then(() => undefined);
      await flush();
      const after = await fileTotals(fileId);
      // Only the one authorised key read above (api channel) may have been added; nothing else.
      expect(Number(after!.total_count)).toBe(Number(JSON.parse(t0)[0].total_count) + 1);
      expect(await fileTotals(foreignFileId)).toBeUndefined();
    });

    it('keeps requests working and unchanged when the persistence layer fails', async () => {
      const { UsagePersistenceService } = await import('../src/usage/usage-persistence.service.js');
      const persist = vi.spyOn(app.get(UsagePersistenceService), 'persistBatch').mockRejectedValue(Object.assign(new Error(`connect ECONNREFUSED ${S.driver}`), { detail: S.driver }));
      const ok = await api('GET', `/workspaces/${wsA}/memories/${memoryId}`);
      expect(ok.status).toBe(200);
      await flush();
      await flush();
      expect(persist).toHaveBeenCalled();
      const again = await api('GET', `/workspaces/${wsA}/memories/${memoryId}`);
      expect(again.status).toBe(200);
      persist.mockRestore();
    });
  });

  describe('privacy (AC-5)', () => {
    it('keeps planted sentinels out of mcp_calls, usage tables, logs and analytics responses', async () => {
      const c = await connect(key);
      // Successful reads and writes carrying sentinels in queries, content, titles, metadata and tags.
      await tool(c, 'search_knowledge', { query: `${S.query} ${S.fileContent}`, tags: [S.tag], types: ['files', 'memories'] });
      await tool(c, 'get_context', { query: `${S.query} ${S.memContent}`, maxChars: 800 });
      await tool(c, 'recall', { query: S.query, tags: [S.tag] });
      await tool(c, 'list_files', { name: S.query, tag: S.tag });
      await tool(c, 'list_memories', { text: S.query, tag: S.tag });
      await tool(c, 'get_file', { fileId });
      await tool(c, 'get_file_chunks', { fileId, cursor: S.bad });
      const remembered = (await tool(c, 'remember', { type: 'fact', content: `${S.memContent} second`, title: S.title, metadata: { note: S.metadata }, tags: [S.tag] })) as any;
      await tool(c, 'update_memory', { id: remembered.structuredContent?.id ?? memoryId, type: 'fact', content: `${S.memContent} updated`, title: S.title, metadata: { n: S.metadata }, confidence: null, source: S.bad, tags: [S.tag] });
      await tool(c, 'upload_file', { name: 'privacy-upload.md', text: `# up\n${S.fileContent}\n`, tags: [S.tag] });
      // Failure paths: validation, foreign and unknown ids, unknown tools, forbidden, truncation.
      await tool(c, 'search_knowledge', { query: { nested: S.bad }, limit: S.bad, extra: S.bad });
      await tool(c, 'get_file', { fileId: foreignFileId, note: S.bad });
      await tool(c, 'get_file', { fileId: `${S.bad}-id` });
      await tool(c, `${S.bad}-no-such-tool`, { query: S.bad });
      await tool(c, 'forget', { id: randomUUID(), reason: S.bad });
      await (await connect(readKey)).listTools();
      await tool(await connect(readKey), 'remember', { type: 'fact', content: S.memContent, title: S.title });
      // REST channels.
      await api('POST', `/workspaces/${wsA}/search`, { query: S.query, tags: [S.tag] }, undefined, bearer(key));
      await api('POST', `/workspaces/${wsA}/context`, { query: S.query, maxChars: 900 });
      await api('GET', `/workspaces/${wsA}/files/${fileId}/download`);
      await api('GET', `/workspaces/${wsA}/memories?text=${S.query}&tag=${S.tag}`);
      await api('GET', `/workspaces/${wsA}/memories/${memoryId}/related`);
      // Observer / flush DB failure with a hostile driver message.
      const { UsagePersistenceService } = await import('../src/usage/usage-persistence.service.js');
      const persist = vi.spyOn(app.get(UsagePersistenceService), 'persistBatch').mockRejectedValue(Object.assign(new Error(`password authentication failed ${S.driver}`), { detail: S.driver, query: S.query }));
      await tool(c, 'get_file', { fileId });
      await flush();
      await flush();
      persist.mockRestore();
      // A logger that throws must not break recording or leak.
      await tool(c, 'get_file', { fileId });
      await flush();

      const stored = await dumpUsageTables();
      expect((await q('SELECT count(*)::int AS n FROM mcp_calls'))[0]!.n).toBeGreaterThan(10);
      for (const s of ALL_SENTINELS) expect(stored, `usage tables contain ${s}`).not.toContain(s);

      // Batch metadata: the ledger holds ids and counts only.
      for (const row of await q('SELECT * FROM usage_batches')) for (const s of ALL_SENTINELS) expect(JSON.stringify(row)).not.toContain(s);

      // Analytics responses.
      const responses: string[] = [];
      const calls = await api('GET', `/workspaces/${wsA}/mcp-calls?limit=100`);
      expect(calls.status).toBe(200);
      responses.push(calls.text);
      for (const item of calls.json.items.slice(0, 40)) responses.push((await api('GET', `/workspaces/${wsA}/mcp-calls/${item.id}`)).text);
      for (const p of [
        `/workspaces/${wsA}/usage/overview`, `/workspaces/${wsA}/usage/top?kind=file`, `/workspaces/${wsA}/usage/top?kind=memory`,
        `/workspaces/${wsA}/usage/unused?kind=file`, `/workspaces/${wsA}/files/${fileId}/usage`, `/workspaces/${wsA}/memories/${memoryId}/usage`,
        '/global/usage/overview', '/global/mcp-calls', '/global/usage/top?kind=file',
      ]) responses.push((await api('GET', p)).text);
      const allResponses = responses.join('\n');
      for (const s of ALL_SENTINELS) expect(allResponses, `usage API response contains ${s}`).not.toContain(s);

      // Logs, including the failing-flush path.
      const logged = logs.join('\n');
      for (const s of ALL_SENTINELS) expect(logged, `logs contain ${s}`).not.toContain(s);
    });

    it('caps the stored arguments to the allowlist: only ids, enums and bounded numbers survive', async () => {
      const rows = await q(`SELECT tool, args_summary FROM mcp_calls WHERE tool IN ('search_knowledge','list_files','get_file_chunks')`);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) {
        for (const v of Object.values(r.args_summary as Record<string, unknown>)) {
          expect(typeof v === 'string' ? /^[0-9a-f-]{36}$|^[a-z_]{1,20}$/i.test(v) : true).toBe(true);
        }
        expect(Object.keys(r.args_summary)).not.toContain('query');
        expect(Object.keys(r.args_summary)).not.toContain('cursor');
      }
    });
  });

  describe('MCP history and attribution (AC-4, AC-6)', () => {
    it('records the final result only, keeps the key-name snapshot after the key is revoked, and cascades with the Workspace', async () => {
      const before = (await q('SELECT count(*)::int AS n FROM mcp_calls WHERE key_id = $1', [readKey.id]))[0]!.n;
      expect(before).toBeGreaterThan(0);
      const revoked = await api('POST', `/workspaces/${wsA}/api-keys/${readKey.id}/revoke`);
      expect(revoked.status).toBe(200);
      const rows = await q('SELECT key_name FROM mcp_calls WHERE key_id = $1', [readKey.id]);
      expect(rows).toHaveLength(before);
      expect(new Set(rows.map((r) => r.key_name))).toEqual(new Set(['privacy-read']));
      const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(readKey) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
      expect(res.status).toBe(401);
      await flush();
      expect((await q('SELECT count(*)::int AS n FROM mcp_calls WHERE key_id = $1', [readKey.id]))[0]!.n).toBe(before);
    });

    it('deletes usage rows with the resource and with the Workspace', async () => {
      expect(await fileTotals(fileId)).toBeDefined();
      expect((await api('DELETE', `/workspaces/${wsA}/files/${fileId}`)).status).toBe(204);
      expect(await fileTotals(fileId)).toBeUndefined();
      expect(await q('SELECT 1 FROM file_usage_daily WHERE file_id = $1', [fileId])).toEqual([]);
      const del = await api('DELETE', `/workspaces/${wsA}`, { slug: 'alpha' });
      expect([200, 204]).toContain(del.status);
      expect(await q('SELECT 1 FROM mcp_calls WHERE workspace_id = $1', [wsA])).toEqual([]);
      expect(await q('SELECT 1 FROM memory_usage_totals WHERE memory_id = $1', [memoryId])).toEqual([]);
    });
  });

  describe('admin-only analytics routes (AC-7)', () => {
    it('gives 401 without credentials, 403 to keys and identical 404s for foreign and unknown ids', async () => {
      const routes = [
        `/workspaces/${wsB}/usage/overview`, `/workspaces/${wsB}/usage/top?kind=file`, `/workspaces/${wsB}/usage/unused?kind=file`,
        `/workspaces/${wsB}/mcp-calls`, `/global/usage/overview`, `/global/mcp-calls`,
      ];
      for (const r of routes) {
        expect((await api('GET', r, undefined, undefined, {})).status, `${r} unauthenticated`).toBe(401);
        expect((await api('GET', r, undefined, undefined, bearer(key))).status, `${r} key`).toBe(403);
      }
      const foreign = await api('GET', `/workspaces/${wsB}/files/${randomUUID()}/usage`);
      const unknown = await api('GET', `/workspaces/${wsB}/files/${randomUUID()}/usage`);
      expect(foreign.status).toBe(404);
      expect(unknown.text.replace(/[0-9a-f-]{36}/g, 'ID')).toBe(foreign.text.replace(/[0-9a-f-]{36}/g, 'ID'));
      const nested = await api('GET', `/workspaces/${wsB}/files/${foreignFileId}/usage`);
      expect(nested.status).toBe(200);
      const crossScope = await api('GET', `/global/files/${foreignFileId}/usage`);
      expect(crossScope.status).toBe(404);
      expect(crossScope.text.replace(/[0-9a-f-]{36}/g, 'ID')).toBe(foreign.text.replace(/[0-9a-f-]{36}/g, 'ID'));
    });
  });
});
