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
import { FilesController } from '../src/files/files.controller.js';
import { FilesService } from '../src/files/files.service.js';
import { MemoriesController } from '../src/memories/memories.controller.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { memoryContentHash } from '../src/memories/memory-content.js';
import { UsageController } from '../src/usage/usage.controller.js';
import { UsageService } from '../src/usage/usage.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV, TEST_API_KEY_PEPPER } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const NOW = new Date('2026-11-06T10:00:00.000Z');
const SENTINEL = 'SENTINEL-usage-title-4471';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const dayOffset = (n: number) => new Date(Date.UTC(2026, 10, 6) - n * 86_400_000).toISOString().slice(0, 10);

/** Fixed clock so the UTC window boundaries are deterministic. */
class FixedUsageService extends UsageService {
  protected override now(): Date {
    return NOW;
  }
}

type Sc = 'A' | 'B' | 'G';

describeIntegration('admin usage API (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let admin: string;
  let keyStore: ApiKeyStore;
  let wsA: string;
  let wsB: string;
  let n = 0;
  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const cols = (s: Sc) => (s === 'G' ? ['global', null] : ['workspace', s === 'A' ? wsA : wsB]);
  const path = (s: Sc, rest: string) => (s === 'G' ? `/api/global/${rest}` : `/api/workspaces/${s === 'A' ? wsA : wsB}/${rest}`);

  async function addFile(s: Sc, createdAt = new Date(NOW.getTime() - ++n * 1000)) {
    return (
      await q(
        `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, ingestion_status, created_at)
         VALUES ($1,$2,$3,'md','text/markdown',1,$4,$5,'indexed',$6) RETURNING id`,
        [...cols(s), `${SENTINEL}-${n}.md`, sha(`f${n}`), `k/${n}`, createdAt],
      )
    )[0]!.id as string;
  }
  async function addMemory(s: Sc, status = 'active', createdAt = new Date(NOW.getTime() - ++n * 1000)) {
    const content = `${SENTINEL} content ${n}`;
    return (
      await q(
        `INSERT INTO memories (scope, workspace_id, type, content, title, metadata, status, created_by_kind, content_hash, created_at)
         VALUES ($1,$2,'decision',$3,$4,$5,$6,'admin',$7,$8) RETURNING id`,
        [...cols(s), content, `${SENTINEL} title`, JSON.stringify({ note: SENTINEL }), status, memoryContentHash(content), createdAt],
      )
    )[0]!.id as string;
  }
  /** Writes daily rows and a consistent lifetime total; `prunedLifetime` models daily rows already pruned. */
  async function use(
    kind: 'file' | 'memory',
    s: Sc,
    id: string,
    daily: Array<{ day: string; channel?: 'ui' | 'api' | 'mcp'; kind?: 'read' | 'retrieved'; count: number }>,
    prunedLifetime = 0,
    lastAt = NOW,
  ) {
    const idCol = `${kind}_id`;
    for (const d of daily) {
      await q(
        `INSERT INTO ${kind}_usage_daily (scope, workspace_id, ${idCol}, day, channel, access_kind, count) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [...cols(s), id, d.day, d.channel ?? 'ui', d.kind ?? 'read', d.count],
      );
    }
    const sum = (pred: (d: (typeof daily)[number]) => boolean) => daily.filter(pred).reduce((a, d) => a + d.count, 0);
    const ui = sum((d) => (d.channel ?? 'ui') === 'ui') + prunedLifetime;
    const api = sum((d) => d.channel === 'api');
    const mcp = sum((d) => d.channel === 'mcp');
    const retrieved = sum((d) => d.kind === 'retrieved');
    const total = ui + api + mcp;
    await q(
      `INSERT INTO ${kind}_usage_totals (scope, workspace_id, ${idCol}, total_count, read_count, retrieved_count, ui_count, api_count, mcp_count, last_accessed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [...cols(s), id, total, total - retrieved, retrieved, ui, api, mcp, lastAt],
    );
  }

  const call = async (url: string, auth: { cookie?: string; bearer?: string } | null = { cookie: admin }) => {
    const headers: Record<string, string> = {};
    if (auth?.cookie) headers.cookie = auth.cookie;
    if (auth?.bearer) headers.authorization = `Bearer ${auth.bearer}`;
    const res = await fetch(`${base}${url}`, { headers });
    const text = await res.text();
    return { status: res.status, text, json: text ? JSON.parse(text) : null, res };
  };
  const key = async (ws: string, permissions: Permission[]) => ({ bearer: (await keyStore.create({ workspaceId: ws, name: 'k', permissions })).secret });

  let fileA: string;
  let fileA2: string;
  let fileB: string;
  let fileG: string;
  let memA: string;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('A','ws-a') RETURNING id`))[0] as { id: string }).id;
    wsB = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('B','ws-b') RETURNING id`))[0] as { id: string }).id;
    keyStore = new ApiKeyStore(ds.getRepository(ApiKey), { apiKeyPepper: TEST_API_KEY_PEPPER });

    fileA = await addFile('A');
    fileA2 = await addFile('A');
    fileB = await addFile('B');
    fileG = await addFile('G');
    memA = await addMemory('A');
    await use('file', 'A', fileA, [
      { day: dayOffset(0), channel: 'ui', kind: 'read', count: 2 },
      { day: dayOffset(0), channel: 'mcp', kind: 'retrieved', count: 3 },
      { day: dayOffset(29), channel: 'api', kind: 'read', count: 4 },
      { day: dayOffset(30), channel: 'api', kind: 'read', count: 100 },
    ], 10);
    await use('file', 'B', fileB, [{ day: dayOffset(0), count: 50 }]);
    await use('file', 'G', fileG, [{ day: dayOffset(1), count: 7 }]);
    await use('memory', 'A', memA, [{ day: dayOffset(2), channel: 'mcp', kind: 'retrieved', count: 5 }]);

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [UsageController, FilesController, MemoriesController],
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
        // The list projections only need the data source and authorization; the other collaborators are for writes.
        { provide: FilesService, useFactory: (d: DataSource, a: AuthorizationService) => new FilesService(d, a, null as never, null as never, null as never, null as never, null as never, { maxUploadBytes: 1 } as never), inject: [getDataSourceToken(), AuthorizationService] },
        { provide: MemoriesService, useFactory: (d: DataSource, a: AuthorizationService) => new MemoriesService(d, a, null as never), inject: [getDataSourceToken(), AuthorizationService] },
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

  it('file usage: lifetime survives pruned dailies, series is zero-filled and cut at the UTC window', async () => {
    const r = await call(path('A', `files/${fileA}/usage`));
    expect(r.status).toBe(200);
    expect(r.json.window).toEqual({ days: 30, from: dayOffset(29), to: dayOffset(0) });
    expect(r.json.daily).toHaveLength(30);
    expect(r.json.daily[0]).toMatchObject({ day: dayOffset(29), total: 4, byChannel: { ui: 0, api: 4, mcp: 0 }, byKind: { read: 4, retrieved: 0 } });
    expect(r.json.daily[29]).toMatchObject({ day: dayOffset(0), total: 5, byChannel: { ui: 2, api: 0, mcp: 3 }, byKind: { read: 2, retrieved: 3 } });
    expect(r.json.daily[10].total).toBe(0);
    // dayOffset(30) is outside the 30-day window but inside the lifetime total (plus 10 from pruned days).
    expect(r.json.lifetime).toEqual({ total: 119, byChannel: { ui: 12, api: 104, mcp: 3 }, byKind: { read: 116, retrieved: 3 } });
    expect(r.json.lastAccessedAt).toBe(NOW.toISOString());
    expect(r.json).toMatchObject({ resource: 'file', id: fileA, scope: 'workspace', workspaceId: wsA });
    const d7 = await call(path('A', `files/${fileA}/usage?days=7`));
    expect(d7.json.daily).toHaveLength(7);
    expect(d7.json.daily.reduce((a: number, p: { total: number }) => a + p.total, 0)).toBe(5);
    const d90 = await call(path('A', `files/${fileA}/usage?days=90`));
    expect(d90.json.daily).toHaveLength(90);
    expect(d90.json.daily.reduce((a: number, p: { total: number }) => a + p.total, 0)).toBe(109);
  });

  it('a never-accessed resource has zero lifetime, null last access and a zero series', async () => {
    const r = await call(path('A', `files/${fileA2}/usage`));
    expect(r.status).toBe(200);
    expect(r.json.lifetime).toEqual({ total: 0, byChannel: { ui: 0, api: 0, mcp: 0 }, byKind: { read: 0, retrieved: 0 } });
    expect(r.json.lastAccessedAt).toBeNull();
    expect(r.json.daily.every((p: { total: number }) => p.total === 0)).toBe(true);
  });

  it('memory usage works in Workspace and Global; Global resources are Global, not aggregated Workspace data', async () => {
    const m = await call(path('A', `memories/${memA}/usage?days=7`));
    expect(m.status).toBe(200);
    expect(m.json.lifetime).toEqual({ total: 5, byChannel: { ui: 0, api: 0, mcp: 5 }, byKind: { read: 0, retrieved: 5 } });
    const g = await call(path('G', `files/${fileG}/usage`));
    expect(g.status).toBe(200);
    expect(g.json).toMatchObject({ scope: 'global', workspaceId: null });
    expect(g.json.lifetime.total).toBe(7);
  });

  it('validates days, resource, limit and cursor with one generic 400', async () => {
    for (const bad of ['days=14', 'days=0', 'days=7&days=30', 'days=abc', 'days=030x', 'x=1', 'days=-7']) {
      const r = await call(path('A', `files/${fileA}/usage?${bad}`));
      expect(r.status, bad).toBe(400);
      expect(r.text).not.toContain('abc');
    }
    for (const bad of ['', 'resource=folder', 'resource=file&limit=0', 'resource=file&limit=101', 'resource=file&limit=x', 'resource=file&days=5']) {
      expect((await call(path('A', `usage/top?${bad}`))).status, bad).toBe(400);
    }
    for (const bad of ['', 'resource=file&limit=101', 'resource=file&cursor=%25%25', 'resource=file&cursor=e30', 'resource=memory&days=1']) {
      expect((await call(path('A', `usage/unused?${bad}`))).status, bad).toBe(400);
    }
  });

  it('unknown, malformed, foreign-Workspace and foreign-Global ids give byte-identical 404s', async () => {
    const urls = [
      path('A', `files/${randomUUID()}/usage`),
      path('A', 'files/not-a-uuid/usage'),
      path('A', `files/${fileB}/usage`),
      path('A', `files/${fileG}/usage`),
      path('G', `files/${fileA}/usage`),
      path('A', `memories/${randomUUID()}/usage`),
      path('B', `memories/${memA}/usage`),
      path('G', `memories/${memA}/usage`),
      path('A', `memories/${fileA}/usage`),
    ];
    const bodies = new Set<string>();
    for (const u of urls) {
      const r = await call(u);
      expect(r.status, u).toBe(404);
      bodies.add(r.text);
    }
    expect(bodies.size).toBe(1);
    const noWs = await call(`/api/workspaces/${randomUUID()}/files/${fileA}/usage`);
    expect(noWs.status).toBe(404);
    expect(noWs.text).toBe([...bodies][0]);
  });

  it('top: counts within the window only, ties by id, zero-use excluded, scopes never mixed, limit applied', async () => {
    const t1 = await addFile('A');
    const t2 = await addFile('A');
    await use('file', 'A', t1, [{ day: dayOffset(1), count: 10 }]);
    await use('file', 'A', t2, [{ day: dayOffset(3), count: 10 }, { day: dayOffset(30), count: 1000 }]);
    const r = await call(path('A', 'usage/top?resource=file'));
    expect(r.status).toBe(200);
    const ids = r.json.items.map((i: { id: string }) => i.id);
    const tied = [t1, t2].sort();
    expect(ids).toEqual([tied[0], tied[1], fileA]);
    expect(r.json.items.map((i: { count: number }) => i.count)).toEqual([10, 10, 5 + 4]);
    expect(ids).not.toContain(fileA2);
    expect(ids).not.toContain(fileB);
    expect(ids).not.toContain(fileG);
    const lim = await call(path('A', 'usage/top?resource=file&limit=1'));
    expect(lim.json.items.map((i: { id: string }) => i.id)).toEqual([tied[0]]);
    const g = await call(path('G', 'usage/top?resource=file&days=90'));
    expect(g.json.items.map((i: { id: string }) => i.id)).toEqual([fileG]);
    const mem = await call(path('A', 'usage/top?resource=memory&days=7'));
    expect(mem.json.items).toEqual([{ resource: 'memory', id: memA, count: 5, lastAccessedAt: NOW.toISOString() }]);
    const empty = await call(path('B', 'usage/top?resource=memory'));
    expect(empty.json.items).toEqual([]);
  });

  it('unused: zero-use and out-of-window resources, memories active only, scoped, cursor pages without gaps on equal timestamps', async () => {
    const wsU = ((await q(`INSERT INTO workspaces (name, slug) VALUES ('U','ws-u') RETURNING id`))[0] as { id: string }).id;
    const same = new Date('2026-10-01T00:00:00.000Z');
    const mk = async (status = 'active') => {
      const content = `unused ${randomUUID()}`;
      return (await q(`INSERT INTO memories (scope, workspace_id, type, content, status, created_by_kind, content_hash, created_at) VALUES ('workspace',$1,'fact',$2,$3,'admin',$4,$5) RETURNING id`, [wsU, content, status, memoryContentHash(content), same]))[0]!.id as string;
    };
    const ids = [await mk(), await mk(), await mk(), await mk(), await mk()];
    await mk('superseded');
    // used inside the window -> not unused; used only outside the window (31 days ago) -> unused with a last access.
    const used = await mk();
    const old = await mk();
    const cols2 = ['workspace', wsU];
    await q(`INSERT INTO memory_usage_daily (scope, workspace_id, memory_id, day, channel, access_kind, count) VALUES ($1,$2,$3,$4,'ui','read',1)`, [...cols2, used, dayOffset(29)]);
    await q(`INSERT INTO memory_usage_daily (scope, workspace_id, memory_id, day, channel, access_kind, count) VALUES ($1,$2,$3,$4,'ui','read',1)`, [...cols2, old, dayOffset(30)]);
    await q(`INSERT INTO memory_usage_totals (scope, workspace_id, memory_id, total_count, read_count, retrieved_count, ui_count, api_count, mcp_count, last_accessed_at) VALUES ($1,$2,$3,1,1,0,1,0,0,$4)`, [...cols2, old, new Date(`${dayOffset(30)}T08:00:00Z`)]);
    const expected = [...ids, old].sort().reverse();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 6; i++) {
      const page = await call(`/api/workspaces/${wsU}/usage/unused?resource=memory&limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(page.status).toBe(200);
      seen.push(...page.json.items.map((it: { id: string }) => it.id));
      cursor = page.json.nextCursor;
      if (!page.json.hasMore) break;
    }
    expect(seen).toEqual(expected);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).not.toContain(used);
    const first = await call(`/api/workspaces/${wsU}/usage/unused?resource=memory&limit=100`);
    const oldItem = first.json.items.find((i: { id: string }) => i.id === old);
    expect(oldItem).toMatchObject({ type: 'fact', lastAccessedAt: `${dayOffset(30)}T08:00:00.000Z` });
    expect(first.json.items.find((i: { id: string }) => i.id === ids[0])!.lastAccessedAt).toBeNull();
    // 90-day window: the 30-days-ago access is inside, so `old` is no longer unused.
    const wide = await call(`/api/workspaces/${wsU}/usage/unused?resource=memory&days=90&limit=100`);
    expect(wide.json.items.map((i: { id: string }) => i.id)).not.toContain(old);
    // Files: never-accessed files of this scope only.
    const files = await call(path('A', 'usage/unused?resource=file'));
    expect(files.json.items.map((i: { id: string }) => i.id)).toContain(fileA2);
    expect(files.json.items.map((i: { id: string }) => i.id)).not.toContain(fileB);
    expect(files.json.items.map((i: { id: string }) => i.id)).not.toContain(fileG);
    expect(files.json.items.every((i: { type: unknown }) => i.type === null)).toBe(true);
  });

  it('API keys get 403 on every usage route, even with every permission and in their own Workspace', async () => {
    const all: Permission[] = ['files:read', 'files:write', 'files:delete', 'memories:read', 'memories:write', 'memories:delete', 'collections:read', 'collections:write', 'search', 'global:read'];
    const k = await key(wsA, all);
    const urls = [
      path('A', `files/${fileA}/usage`), path('A', `memories/${memA}/usage`), path('A', 'usage/top?resource=file'), path('A', 'usage/unused?resource=file'),
      path('G', `files/${fileG}/usage`), path('G', `memories/${memA}/usage`), path('G', 'usage/top?resource=file'), path('G', 'usage/unused?resource=file'),
    ];
    // Another Workspace is concealed exactly like a missing one, before any admin check.
    const missing = await call(`/api/workspaces/${randomUUID()}/usage/top?resource=file`, k);
    for (const u of [path('B', `files/${fileB}/usage`), path('B', 'usage/top?resource=file')]) {
      const r = await call(u, k);
      expect(r.status, u).toBe(404);
      expect(r.text).toBe(missing.text);
    }
    for (const u of urls) {
      const r = await call(u, k);
      expect(r.status, u).toBe(403);
      expect(r.text).not.toContain(fileA);
      expect(r.text).not.toContain('count');
    }
  });

  it('unauthenticated callers get 401', async () => {
    for (const u of [path('A', `files/${fileA}/usage`), path('G', 'usage/top?resource=file'), path('A', 'usage/unused?resource=memory')]) {
      expect((await call(u, null)).status, u).toBe(401);
    }
  });

  it('list responses: admin gets 30-day counts and last access; keys get neither property', async () => {
    const files = await call(path('A', 'files?limit=100'));
    expect(files.status).toBe(200);
    const byId = new Map<string, any>(files.json.items.map((i: { id: string }) => [i.id, i]));
    expect(byId.get(fileA)).toMatchObject({ accessCount30d: 9, lastAccessedAt: NOW.toISOString() });
    expect(byId.get(fileA2)).toMatchObject({ accessCount30d: 0, lastAccessedAt: null });
    const gFiles = await call(path('G', 'files'));
    expect(gFiles.json.items.find((i: { id: string }) => i.id === fileG)).toMatchObject({ accessCount30d: 7 });
    const mems = await call(path('A', 'memories'));
    expect(mems.json.items.find((i: { id: string }) => i.id === memA)).toMatchObject({ accessCount30d: 5, lastAccessedAt: NOW.toISOString() });

    const k = await key(wsA, ['files:read', 'memories:read', 'global:read']);
    for (const u of [path('A', 'files?limit=100'), path('A', 'memories'), path('G', 'files'), path('G', 'memories')]) {
      const r = await call(u, k);
      expect(r.status, u).toBe(200);
      expect(r.text).not.toContain('accessCount30d');
      expect(r.text).not.toContain('lastAccessedAt');
      for (const item of r.json.items) {
        expect('accessCount30d' in item).toBe(false);
        expect('lastAccessedAt' in item).toBe(false);
      }
    }
  });

  it('list projection uses a constant number of usage queries regardless of page size', async () => {
    const spy = vi.spyOn(ds, 'query');
    await call(path('A', 'files?limit=100'));
    const usageQueries = spy.mock.calls.filter(([sql]) => /_usage_(daily|totals)/.test(String(sql))).length;
    spy.mockRestore();
    expect(usageQueries).toBe(2);
  });

  it('usage responses are minimal projections: no names, titles, content, metadata or tags', async () => {
    const responses = [
      await call(path('A', `files/${fileA}/usage`)),
      await call(path('A', `memories/${memA}/usage`)),
      await call(path('A', 'usage/top?resource=file')),
      await call(path('A', 'usage/top?resource=memory')),
      await call(path('A', 'usage/unused?resource=file')),
      await call(path('A', 'usage/unused?resource=memory')),
      await call(path('G', 'usage/unused?resource=memory')),
    ];
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.text).not.toContain(SENTINEL);
      expect(r.text).not.toMatch(/"(name|title|content|metadata|tags|query|summary)"/);
    }
  });
});
