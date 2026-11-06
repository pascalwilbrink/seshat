import 'reflect-metadata';
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { McpCallsController } from '../src/usage/mcp-calls.controller.js';
import { McpCallsService } from '../src/usage/mcp-calls.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const SENTINEL = 'SENTINEL-call-title-8842';
const T0 = new Date('2026-11-06T10:00:00.000Z');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describeIntegration('admin MCP call history API (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let admin: string;
  let keyStore: ApiKeyStore;
  let wsA: string;
  let wsB: string;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const KEY1 = randomUUID();
  const KEY2 = randomUUID();
  const KEY_B = randomUUID();
  let n = 0;

  async function addCall(
    ws: string,
    o: Partial<{ at: Date; keyId: string; keyName: string; client: string | null; tool: string; outcome: string; args: object; id: string }> = {},
  ): Promise<string> {
    const id = o.id ?? randomUUID();
    await q(
      `INSERT INTO mcp_calls (id, occurred_at, workspace_id, key_id, key_name, client_name, client_version, tool, outcome, duration_ms, result_chars, truncated, args_summary)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [id, o.at ?? new Date(T0.getTime() - ++n * 1000), ws, o.keyId ?? KEY1, o.keyName ?? 'agent-one', o.client === undefined ? 'claude' : o.client, o.client === null ? null : '1.0', o.tool ?? 'recall', o.outcome ?? 'ok', 12, 345, false, JSON.stringify(o.args ?? { limit: 5 })],
    );
    return id;
  }
  async function addFile(scopeKind: 'A' | 'G') {
    return (
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status)
         VALUES ($1,$2,$3,'md','text/markdown',1,$4,$5,'indexed') RETURNING id`,
        [scopeKind === 'G' ? 'global' : 'workspace', scopeKind === 'G' ? null : wsA, `${SENTINEL}-${++n}.md`, sha(`f${n}`), `k/${n}`],
      )
    )[0]!.id as string;
  }
  const touch = (callId: string, kind: string, id: string, action: string, scopeKey: string) =>
    q(`INSERT INTO mcp_call_resources (call_id, resource_kind, resource_id, action, scope_key) VALUES ($1,$2,$3,$4,$5)`, [callId, kind, id, action, scopeKey]);

  const call = async (url: string, auth: { cookie?: string; bearer?: string } | null = { cookie: admin }) => {
    const headers: Record<string, string> = {};
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const res = await fetch(`${base}${url}`, { headers });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };
  const wsPath = (ws: string, rest = '') => `/api/workspaces/${ws}/mcp-calls${rest}`;
  const pageAll = async (url: string, limit: number) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 50; i++) {
      const r = await call(`${url}${url.includes('?') ? '&' : '?'}limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`);
      expect(r.status).toBe(200);
      ids.push(...r.json.items.map((x: { id: string }) => x.id));
      if (!r.json.hasMore) return ids;
      cursor = r.json.nextCursor;
    }
    throw new Error('did not terminate');
  };

  let tied: string[];
  let detailId: string;
  let fileLive: string;
  let fileGone: string;
  let fileGlobal: string;
  let callB: string;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('Alpha','ws-a') RETURNING id`))[0] as { id: string }).id;
    wsB = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('Beta','ws-b') RETURNING id`))[0] as { id: string }).id;
    keyStore = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });

    // Five calls share one timestamp (tie-breaker is the id), plus distinct ones.
    tied = [];
    for (let i = 0; i < 5; i++) tied.push(await addCall(wsA, { at: T0, tool: 'recall' }));
    await addCall(wsA, { at: new Date(T0.getTime() - 60_000), tool: 'remember', outcome: 'validation_error', keyId: KEY2, keyName: 'agent-two', client: null });
    await addCall(wsA, { at: new Date(T0.getTime() - 3_600_000), tool: 'upload_file', outcome: 'forbidden', client: 'cursor' });
    await addCall(wsA, { at: new Date(T0.getTime() - 86_400_000 * 3), tool: 'recall', outcome: 'ok' });
    callB = await addCall(wsB, { at: T0, tool: 'recall', keyId: KEY_B, keyName: 'beta-key' });

    fileLive = await addFile('A');
    fileGone = randomUUID();
    fileGlobal = await addFile('G');
    detailId = await addCall(wsA, { at: new Date(T0.getTime() + 1000), tool: 'get_context', args: { limit: 3, types: ['files'] } });
    await touch(detailId, 'file', fileLive, 'retrieved', wsA);
    await touch(detailId, 'file', fileGone, 'deleted', wsA);
    await touch(detailId, 'file', fileGlobal, 'read', 'global');

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [McpCallsController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: keyStore },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        { provide: 'WorkspaceRepository', useValue: ds.getRepository(Workspace) },
        McpCallsService,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    admin = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    vi.unstubAllEnvs();
  });

  it('lists a Workspace newest first with no Workspace identity and no foreign rows', async () => {
    const r = await call(wsPath(wsA));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ scope: 'workspace', workspaceId: wsA, hasMore: false, limit: 25 });
    expect(r.json.items).toHaveLength(9);
    expect(r.json.items[0].id).toBe(detailId);
    expect(r.json.items.every((i: { workspace?: unknown; id: string }) => i.workspace === undefined && i.id !== callB)).toBe(true);
    expect(r.json.items[0]).toEqual({
      id: detailId, occurredAt: new Date(T0.getTime() + 1000).toISOString(), keyId: KEY1, keyName: 'agent-one', clientName: 'claude', clientVersion: '1.0',
      tool: 'get_context', outcome: 'ok', durationMs: 12, resultChars: 345, truncated: false,
    });
    const times = r.json.items.map((i: { occurredAt: string }) => i.occurredAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('cursor pagination neither drops nor repeats rows that share a timestamp', async () => {
    const all = (await call(wsPath(wsA))).json.items.map((i: { id: string }) => i.id) as string[];
    for (const limit of [1, 2, 3, 4]) expect(await pageAll(wsPath(wsA), limit), `limit ${limit}`).toEqual(all);
    // Tied rows are ordered by descending id.
    const tiedOrder = all.filter((id) => tied.includes(id));
    expect(tiedOrder).toEqual([...tied].sort().reverse());
  });

  it('filters by tool, key id, outcome, client name and date range, and combines them', async () => {
    const ids = async (qs: string) => (await call(`${wsPath(wsA)}?${qs}`)).json.items.map((i: { tool: string }) => i.tool);
    expect((await ids('tool=remember'))).toEqual(['remember']);
    expect(await ids(`keyId=${KEY2}`)).toEqual(['remember']);
    expect(await ids('outcome=forbidden')).toEqual(['upload_file']);
    expect(await ids('clientName=cursor')).toEqual(['upload_file']);
    expect((await ids('clientName=claude')).length).toBe(7);
    expect(await ids(`keyId=${KEY_B}`)).toEqual([]); // another Workspace's key: no rows, no error
    // Day-only bounds are UTC days; `to` includes its whole day.
    expect((await ids('from=2026-11-06&to=2026-11-06')).length).toBe(8);
    expect((await ids('to=2026-11-03')).length).toBe(1);
    // Instants: `from` inclusive, `to` inclusive of that millisecond.
    expect(await ids(`from=${encodeURIComponent('2026-11-06T09:59:00.000Z')}&to=${encodeURIComponent('2026-11-06T09:59:00.000Z')}`)).toEqual(['remember']);
    expect(await ids('tool=recall&outcome=ok&from=2026-11-06')).toHaveLength(5);
    // Filters keep paging stable too.
    expect((await pageAll(`${wsPath(wsA)}?tool=recall`, 2)).length).toBe(6);
  });

  it('rejects malformed filters, limits and cursors with one generic 400 that echoes nothing', async () => {
    const bad = ['limit=0', 'limit=101', 'limit=x', 'outcome=boom', 'keyId=nope', 'tool=a%20b', 'from=yesterday', 'to=2026-13-40', 'from=2026-11-07&to=2026-11-06', 'cursor=%25%25', 'cursor=e30', 'x=1', `tool=${'a'.repeat(129)}`, `clientName=${'c'.repeat(201)}`];
    const bodies = new Set<string>();
    for (const b of bad) {
      const r = await call(`${wsPath(wsA)}?${b}`);
      expect(r.status, b).toBe(400);
      bodies.add(r.text);
    }
    expect(bodies.size).toBeLessThanOrEqual(2); // 'Invalid query' / 'Invalid cursor'
  });

  it('Global lists every Workspace with its identity and filters across them', async () => {
    const r = await call('/api/global/mcp-calls?limit=100');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ scope: 'global', workspaceId: null });
    expect(r.json.items).toHaveLength(10);
    const b = r.json.items.find((i: { id: string }) => i.id === callB);
    expect(b.workspace).toEqual({ id: wsB, slug: 'ws-b', name: 'Beta' });
    expect(r.json.items.find((i: { id: string }) => i.id === detailId).workspace).toEqual({ id: wsA, slug: 'ws-a', name: 'Alpha' });
    const one = await call(`/api/global/mcp-calls?keyId=${KEY_B}`);
    expect(one.json.items.map((i: { id: string }) => i.id)).toEqual([callB]);
    const all = r.json.items.map((i: { id: string }) => i.id);
    expect(await pageAll('/api/global/mcp-calls', 3)).toEqual(all);
  });

  it('detail shows the argument summary and touched resources with deleted markers and no names', async () => {
    const r = await call(wsPath(wsA, `/${detailId}`));
    expect(r.status).toBe(200);
    expect(r.json.argsSummary).toEqual({ limit: 3, types: ['files'] });
    expect(r.json.workspace).toEqual({ id: wsA, slug: 'ws-a', name: 'Alpha' });
    const byId = Object.fromEntries(r.json.resources.map((x: { id: string }) => [x.id, x]));
    expect(byId[fileLive]).toEqual({ kind: 'file', id: fileLive, action: 'retrieved', scope: 'workspace', workspaceId: wsA, deleted: false });
    expect(byId[fileGone]).toEqual({ kind: 'file', id: fileGone, action: 'deleted', scope: 'workspace', workspaceId: wsA, deleted: true });
    expect(byId[fileGlobal]).toEqual({ kind: 'file', id: fileGlobal, action: 'read', scope: 'global', workspaceId: null, deleted: false });
    expect(r.text).not.toContain(SENTINEL);
    const g = await call(`/api/global/mcp-calls/${detailId}`);
    expect(g.status).toBe(200);
    expect(g.json).toEqual(r.json);
    // After the File is deleted the same call reports it as deleted.
    await q(`DELETE FROM files WHERE id = $1`, [fileLive]);
    const after = await call(wsPath(wsA, `/${detailId}`));
    expect(after.json.resources.find((x: { id: string }) => x.id === fileLive)).toMatchObject({ deleted: true });
    expect(after.text).not.toContain(SENTINEL);
  });

  it('foreign, unknown and malformed call ids give byte-identical 404s', async () => {
    const urls = [wsPath(wsA, `/${randomUUID()}`), wsPath(wsA, '/not-a-uuid'), wsPath(wsA, `/${callB}`), wsPath(wsB, `/${detailId}`), `/api/global/mcp-calls/${randomUUID()}`, `/api/global/mcp-calls/nope`, `/api/workspaces/${randomUUID()}/mcp-calls/${detailId}`, `/api/workspaces/${randomUUID()}/mcp-calls`];
    const bodies = new Set<string>();
    for (const u of urls) {
      const r = await call(u);
      expect(r.status, u).toBe(404);
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
  });

  it('admin only: keys get 403 (404 for another Workspace), unauthenticated callers get 401', async () => {
    const key = { bearer: (await keyStore.create({ workspaceId: wsA, name: 'k', permissions: ['files:read', 'memories:read', 'search', 'global:read'] })).secret };
    for (const u of [wsPath(wsA), wsPath(wsA, `/${detailId}`), '/api/global/mcp-calls', `/api/global/mcp-calls/${detailId}`]) {
      expect((await call(u, key)).status, u).toBe(403);
      expect((await call(u, null)).status, u).toBe(401);
    }
    const foreign = await call(wsPath(wsB), key);
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe((await call(wsPath(randomUUID()), key)).text);
  });

  it('keeps the key-name snapshot after the key is revoked or deleted', async () => {
    const created = await keyStore.create({ workspaceId: wsA, name: 'ephemeral', permissions: ['files:read'] });
    const id = await addCall(wsA, { at: new Date(T0.getTime() + 5000), keyId: created.record.id, keyName: 'ephemeral' });
    await q(`UPDATE api_keys SET revoked_at = now() WHERE id = $1`, [created.record.id]);
    expect((await call(wsPath(wsA, `/${id}`))).json.keyName).toBe('ephemeral');
    await q(`DELETE FROM api_keys WHERE id = $1`, [created.record.id]);
    const r = await call(wsPath(wsA, `/${id}`));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ keyId: created.record.id, keyName: 'ephemeral' });
  });

  it('call history disappears with its Workspace', async () => {
    const ws = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('Gone','ws-gone') RETURNING id`))[0] as { id: string }).id;
    const id = await addCall(ws);
    await touch(id, 'file', randomUUID(), 'read', ws);
    expect((await call(wsPath(ws, `/${id}`))).status).toBe(200);
    await q(`DELETE FROM workspaces WHERE id = $1`, [ws]);
    expect((await call(wsPath(ws, `/${id}`))).status).toBe(404);
    expect((await call(`/api/global/mcp-calls/${id}`)).status).toBe(404);
    expect((await q(`SELECT 1 FROM mcp_calls WHERE id = $1`, [id])).length).toBe(0);
    expect((await q(`SELECT 1 FROM mcp_call_resources WHERE call_id = $1`, [id])).length).toBe(0);
  });
});
