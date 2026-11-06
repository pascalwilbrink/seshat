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
import { memoryContentHash } from '../src/memories/memory-content.js';
import { UsageController } from '../src/usage/usage.controller.js';
import { UsageService } from '../src/usage/usage.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const SENTINEL = 'SENTINEL-overview-title-9d21';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dayOffset = (n: number) => new Date(Date.UTC(2026, 10, 6) - n * 86_400_000).toISOString().slice(0, 10);
const at = (day: number, time = '12:00:00.000') => new Date(`${dayOffset(day)}T${time}Z`);

class FixedUsageService extends UsageService {
  protected override now(): Date {
    return NOW;
  }
}

type Sc = 'A' | 'B' | 'G';

describeIntegration('usage overview API (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let admin: string;
  let keyStore: ApiKeyStore;
  let wsA: string;
  let wsB: string;
  let wsEmpty: string;
  let n = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const cols = (s: Sc) => (s === 'G' ? ['global', null] : ['workspace', s === 'A' ? wsA : wsB]);
  const path = (s: Sc, rest: string) => (s === 'G' ? `/api/global/${rest}` : `/api/workspaces/${s === 'A' ? wsA : wsB}/${rest}`);

  async function addFile(s: Sc, status = 'indexed') {
    n++;
    return (
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status)
         VALUES ($1,$2,$3,'md','text/markdown',1,$4,$5,$6) RETURNING id`,
        [...cols(s), `${SENTINEL}-${n}.md`, sha(`f${n}`), `k/${n}`, status],
      )
    )[0]!.id as string;
  }
  async function addMemory(s: Sc, status = 'active') {
    n++;
    const content = `${SENTINEL} content ${n}`;
    return (
      await q(
        `INSERT INTO memories (scope, workspace_id, type, content, title, metadata, status, created_by_kind, content_hash)
         VALUES ($1,$2,'decision',$3,$4,$5,$6,'admin',$7) RETURNING id`,
        [...cols(s), content, `${SENTINEL} title`, JSON.stringify({ note: SENTINEL }), status, memoryContentHash(content)],
      )
    )[0]!.id as string;
  }
  async function use(kind: 'file' | 'memory', s: Sc, id: string, day: string, count: number, channel = 'ui', accessKind = 'read') {
    await q(`INSERT INTO ${kind}_usage_daily (scope, workspace_id, ${kind}_id, day, channel, access_kind, count) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [...cols(s), id, day, channel, accessKind, count]);
  }
  async function mcp(ws: string, tool: string, outcome: string, when: Date) {
    await q(
      `INSERT INTO mcp_calls (id, occurred_at, workspace_id, key_id, key_name, tool, outcome, duration_ms, result_chars, truncated)
       VALUES ($1,$2,$3,$4,'k',$5,$6,1,1,false)`,
      [randomUUID(), when, ws, randomUUID(), tool, outcome],
    );
  }
  const call = async (url: string, auth: { cookie?: string; bearer?: string } | null = { cookie: admin }) => {
    const headers: Record<string, string> = {};
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const res = await fetch(`${base}${url}`, { headers });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null };
  };

  let fA1: string;
  let mA1: string;
  let fG: string;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    const ws = async (slug: string) => ((await q(`INSERT INTO workspaces (name, slug) VALUES ($1,$1) RETURNING id`, [slug]))[0] as { id: string }).id;
    wsA = await ws('ws-a');
    wsB = await ws('ws-b');
    wsEmpty = await ws('ws-empty');
    keyStore = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });

    // Workspace A: 4 files (indexed x2, failed, pending), memories active x2 + superseded; two zero-use resources.
    fA1 = await addFile('A');
    const fA2 = await addFile('A');
    await addFile('A', 'failed');
    await addFile('A', 'pending');
    mA1 = await addMemory('A');
    await addMemory('A');
    await addMemory('A', 'superseded');
    // Workspace B and Global have their own resources and counters that must never leak into A (or into Global metrics).
    const fB = await addFile('B');
    const mB = await addMemory('B');
    fG = await addFile('G');
    const mG = await addMemory('G', 'superseded');
    await use('file', 'A', fA1, dayOffset(0), 2, 'ui', 'read');
    await use('file', 'A', fA1, dayOffset(0), 3, 'mcp', 'retrieved');
    await use('file', 'A', fA2, dayOffset(6), 4, 'api', 'read'); // first day of a 7 day window
    await use('file', 'A', fA2, dayOffset(7), 100, 'api', 'read'); // one day before the 7 day window
    await use('memory', 'A', mA1, dayOffset(1), 5, 'mcp', 'retrieved');
    await use('file', 'B', fB, dayOffset(0), 50);
    await use('memory', 'B', mB, dayOffset(0), 40);
    await use('file', 'G', fG, dayOffset(1), 7);
    await use('memory', 'G', mG, dayOffset(89), 1); // first day of a 90 day window

    // MCP calls: A and B, all outcomes, UTC boundaries (6 day offset = first day of a 7 day window).
    await mcp(wsA, 'recall', 'ok', at(0, '00:00:00.000'));
    await mcp(wsA, 'recall', 'ok', at(0, '09:59:59.999'));
    await mcp(wsA, 'remember', 'validation_error', at(1, '23:59:59.999'));
    await mcp(wsA, 'get_file', 'forbidden', at(2));
    await mcp(wsA, 'get_file', 'not_found', at(2));
    await mcp(wsA, 'nope', 'unknown_tool', at(3));
    await mcp(wsA, 'search_knowledge', 'internal_error', at(4));
    await mcp(wsA, 'list_files', 'ok', at(6, '00:00:00.000'));
    await mcp(wsA, 'list_files', 'ok', new Date(at(7, '00:00:00.000').getTime() - 1)); // 1 ms before the 7 day window
    await mcp(wsA, 'list_files', 'ok', at(-1, '00:00:00.000')); // tomorrow: outside every window
    await mcp(wsB, 'recall', 'ok', at(0));
    await mcp(wsB, 'recall', 'internal_error', at(10));

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [UsageController],
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
        { provide: UsageService, useClass: FixedUsageService },
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

  const sumDays = (rows: Array<{ total: number }>) => rows.reduce((a, r) => a + r.total, 0);

  it('Workspace overview, 30 days: every stat and dataset, scoped to the Workspace', async () => {
    const r = await call(path('A', 'usage/overview'));
    expect(r.status).toBe(200);
    const j = r.json;
    expect(j).toMatchObject({ scope: 'workspace', workspaceId: wsA, window: { days: 30, from: dayOffset(29), to: dayOffset(0) }, callsByWorkspace: null });
    expect(j.files).toEqual({ total: 4, indexed: 2, failed: 1 });
    expect(j.memories).toEqual({ total: 3, active: 2, superseded: 1 });
    // 9 calls in the 30 day window (the 1 ms-before-7d one included, tomorrow excluded); errors = 4 non-ok.
    expect(j.mcp).toEqual({ calls: 9, errors: 5, errorRate: 5 / 9 });
    // Unused in 30 days: files without a counter (3 of 4: fA1 and fA2 are used, the failed and pending ones are not -> 2), active memories (1 of 2).
    expect(j.unused).toEqual({ files: 2, memories: 1 });
    expect(j.accessesDaily).toHaveLength(30);
    expect(j.callsDaily).toHaveLength(30);
    expect(j.accessesDaily[29]).toEqual({ day: dayOffset(0), total: 5, byChannel: { ui: 2, api: 0, mcp: 3 } });
    expect(j.accessesDaily[28]).toEqual({ day: dayOffset(1), total: 5, byChannel: { ui: 0, api: 0, mcp: 5 } });
    expect(sumDays(j.accessesDaily)).toBe(2 + 3 + 4 + 100 + 5);
    expect(j.callsDaily[29]).toMatchObject({ day: dayOffset(0), total: 2, byOutcome: { ok: 2, validation_error: 0 } });
    expect(j.callsDaily[28].byOutcome).toMatchObject({ validation_error: 1 });
    expect(j.callsDaily[27].byOutcome).toMatchObject({ forbidden: 1, not_found: 1 });
    expect(j.callsDaily[26].byOutcome).toMatchObject({ unknown_tool: 1 });
    expect(j.callsDaily[25].byOutcome).toMatchObject({ internal_error: 1 });
    expect(sumDays(j.callsDaily)).toBe(9);
    // Ties are ordered by tool name; tomorrow's list_files call is outside the window.
    expect(j.topTools).toEqual([
      { tool: 'get_file', calls: 2 },
      { tool: 'list_files', calls: 2 },
      { tool: 'recall', calls: 2 },
      { tool: 'nope', calls: 1 },
      { tool: 'remember', calls: 1 },
      { tool: 'search_knowledge', calls: 1 },
    ]);
    expect(j.topFiles).toEqual([expect.objectContaining({ count: 104 }), { id: fA1, count: 5 }]);
    expect(j.topMemories).toEqual([{ id: mA1, count: 5 }]);
  });

  it('7 and 90 day windows cut at the UTC day boundary and zero-fill', async () => {
    const d7 = (await call(path('A', 'usage/overview?days=7'))).json;
    expect(d7.window).toEqual({ days: 7, from: dayOffset(6), to: dayOffset(0) });
    expect(d7.accessesDaily.map((p: { day: string }) => p.day)).toEqual([6, 5, 4, 3, 2, 1, 0].map(dayOffset));
    expect(d7.accessesDaily[0].total).toBe(4); // dayOffset(6) in, dayOffset(7) out
    expect(sumDays(d7.accessesDaily)).toBe(2 + 3 + 4 + 5);
    // 00:00:00.000 of the first day counts, one ms earlier does not.
    expect(d7.mcp.calls).toBe(8);
    expect(d7.callsDaily[0]).toMatchObject({ day: dayOffset(6), total: 1 });
    expect(d7.unused).toEqual({ files: 2, memories: 1 });
    const d90 = (await call(path('A', 'usage/overview?days=90'))).json;
    expect(d90.callsDaily).toHaveLength(90);
    expect(d90.mcp.calls).toBe(9);
    expect(d90.topTools.length).toBeLessThanOrEqual(10);
  });

  it('empty window and empty Workspace: zeros, zero-filled series, zero-safe error rate', async () => {
    const r = await call(`/api/workspaces/${wsEmpty}/usage/overview?days=7`);
    expect(r.status).toBe(200);
    expect(r.json.files).toEqual({ total: 0, indexed: 0, failed: 0 });
    expect(r.json.memories).toEqual({ total: 0, active: 0, superseded: 0 });
    expect(r.json.mcp).toEqual({ calls: 0, errors: 0, errorRate: 0 });
    expect(r.json.unused).toEqual({ files: 0, memories: 0 });
    expect(r.json.accessesDaily).toHaveLength(7);
    expect(r.json.accessesDaily.every((p: { total: number }) => p.total === 0)).toBe(true);
    expect(r.json.callsDaily.every((p: { total: number; byOutcome: Record<string, number> }) => p.total === 0 && Object.values(p.byOutcome).every((v) => v === 0))).toBe(true);
    expect(r.json).toMatchObject({ topTools: [], topFiles: [], topMemories: [] });
  });

  it('Global: resource metrics are Global resources only, MCP aggregates Workspaces with a per-Workspace breakdown', async () => {
    const r = await call(path('G', 'usage/overview?days=90'));
    expect(r.status).toBe(200);
    const j = r.json;
    expect(j).toMatchObject({ scope: 'global', workspaceId: null });
    expect(j.files).toEqual({ total: 1, indexed: 1, failed: 0 });
    expect(j.memories).toEqual({ total: 1, active: 0, superseded: 1 });
    expect(j.unused).toEqual({ files: 0, memories: 0 }); // fG used at -1 days; the superseded memory is not counted
    expect(sumDays(j.accessesDaily)).toBe(8); // not 50/40 of Workspace B, not Workspace A
    expect(j.topFiles).toEqual([{ id: fG, count: 7 }]);
    expect(j.accessesDaily[0]).toMatchObject({ day: dayOffset(89), total: 1 });
    // A: 9 calls, B: 2 calls (both in 90 days); errors A 5, B 1.
    expect(j.mcp).toEqual({ calls: 11, errors: 6, errorRate: 6 / 11 });
    expect(j.callsByWorkspace).toEqual([
      { workspaceId: wsA, slug: 'ws-a', name: 'ws-a', calls: 9 },
      { workspaceId: wsB, slug: 'ws-b', name: 'ws-b', calls: 2 },
    ]);
    expect(j.callsByWorkspace.reduce((a: number, w: { calls: number }) => a + w.calls, 0)).toBe(j.mcp.calls);
    const d30 = (await call(path('G', 'usage/overview'))).json;
    expect(d30.mcp.calls).toBe(11); // B's call 10 days ago is inside 30 days too
    expect(d30.memories).toEqual({ total: 1, active: 0, superseded: 1 });
    expect(sumDays(d30.accessesDaily)).toBe(7); // the 89-days-old Global memory access is outside 30 days
  });

  it('validates days with one generic 400', async () => {
    for (const bad of ['days=14', 'days=0', 'days=7&days=30', 'days=abc', 'x=1', 'days=-7']) {
      const r = await call(path('A', `usage/overview?${bad}`));
      expect(r.status, bad).toBe(400);
      expect(r.text).not.toContain('abc');
    }
  });

  it('is admin only: keys get 403 (own Workspace, Global), another Workspace gets the generic 404, no session gets 401', async () => {
    const all: Permission[] = ['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'memories:delete', 'collections:read', 'collections:write', 'search', 'global:read'];
    const k = { bearer: (await keyStore.create({ workspaceId: wsA, name: 'k', permissions: all })).secret };
    for (const u of [path('A', 'usage/overview'), path('G', 'usage/overview')]) {
      const r = await call(u, k);
      expect(r.status, u).toBe(403);
      expect(r.text).not.toContain('"files"');
    }
    const missing = await call(`/api/workspaces/${randomUUID()}/usage/overview`, k);
    const foreign = await call(path('B', 'usage/overview'), k);
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);
    expect((await call(`/api/workspaces/${randomUUID()}/usage/overview`)).status).toBe(404);
    for (const u of [path('A', 'usage/overview'), path('G', 'usage/overview')]) expect((await call(u, null)).status, u).toBe(401);
  });

  it('response is a minimal projection: no names, titles, content, metadata, queries or arguments', async () => {
    for (const s of ['A', 'G'] as const) {
      const r = await call(path(s, 'usage/overview?days=90'));
      expect(r.text).not.toContain(SENTINEL);
      expect(r.text).not.toMatch(/"(title|content|metadata|tags|query|summary|argsSummary|keyName|keyId)"/);
    }
  });
});
