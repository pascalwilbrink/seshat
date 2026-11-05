import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { ConsoleLogger, type INestApplication, Logger, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Client } from 'pg';
import type { DataSource } from 'typeorm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createDataSourceOptions } from '../src/database/options.js';
import { EmbeddingError, type EmbeddingService } from '../src/ingestion/embedding.service.js';
import { MemoriesController } from '../src/memories/memories.controller.js';
import { MemoriesService } from '../src/memories/memories.service.js';
import { Memory } from '../src/memories/memory.entity.js';
import { MemoryTag } from '../src/memories/memory-tag.entity.js';
import { MemoryEmbeddingCoordinator } from '../src/memories/memory-embedding.coordinator.js';
import { MEMORY_EMBEDDING_COORDINATOR, MemoryEmbeddingWorker } from '../src/memories/memory-embedding.worker.js';
import { EMBED_MEMORY_QUEUE } from '../src/queue/queue.constants.js';
import { QueueService } from '../src/queue/queue.service.js';
import { Tag } from '../src/tags/tag.entity.js';
import { TagsService } from '../src/tags/tags.service.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';

const S = {
  title: 'SENTINEL-TITLE-7f3a',
  content: 'SENTINEL-CONTENT-91bc',
  meta: 'SENTINEL-METADATA-c04d',
  source: 'SENTINEL-SOURCE-2e8f',
  tag: 'sentinel-tag-55aa',
  provider: 'SENTINEL-PROVIDER-ERROR-d1f2',
  db: 'SENTINEL-DB-ERROR-83be',
  vector: '0.314159265358979',
};
const ALL_SENTINELS = Object.values(S);

/** Embeds, fails, hangs or returns a malformed vector made of recognisable coordinates. */
class ScriptedEmbeddings implements EmbeddingService {
  readonly model = 'scripted';
  readonly dimension = 1536;
  behaviour: 'ok' | 'fail' | 'hang' | 'bad-vector' | 'driver-fail' = 'ok';
  async embed(texts: string[]): Promise<number[][]> {
    if (this.behaviour === 'hang') return new Promise(() => undefined);
    if (this.behaviour === 'fail') throw new EmbeddingError('provider_failed', `${S.provider} for input ${texts[0]}`);
    if (this.behaviour === 'driver-fail') throw new Error(`${S.provider} raw ${texts[0]} ${S.vector}`);
    if (this.behaviour === 'bad-vector') return texts.map(() => new Array<number>(7).fill(Number(S.vector)));
    return texts.map(() => [1, ...new Array<number>(1535).fill(0)]);
  }
}

describeIntegration('Memory data is never logged (real PostgreSQL + pg-boss, HTTP)', () => {
  vi.setConfig({ testTimeout: 40_000, hookTimeout: 40_000 });
  let iso: IsolatedSchema;
  let ds: DataSource;
  let admin: Client;
  let app: INestApplication;
  let base: string;
  let cookie: string;
  let wsA: string;
  let bossSchema: string;
  let queue: QueueService;
  let worker: MemoryEmbeddingWorker;
  let embeddings: ScriptedEmbeddings;
  let failTagUnion = false;
  const out: string[] = [];

  const q = async (sql: string, params: unknown[] = []) => (await ds.query(sql, params)) as any[];
  const until = async (cond: () => Promise<boolean>, ms = 25_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('condition not met in time');
  };
  const send = async (method: string, p: string, body?: unknown) => {
    const res = await fetch(`${base}${p}`, { method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, text, json: text ? safeJson(text) : undefined };
  };
  const safeJson = (t: string) => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const w = () => `/api/workspaces/${wsA}/memories`;
  const sentinelBody = (extra: Record<string, unknown> = {}) => ({ type: 'fact', content: S.content, title: S.title, metadata: { k: S.meta }, source: S.source, tags: [S.tag], ...extra });
  const bossRows = async () => (await admin.query(`SELECT * FROM "${bossSchema}".job WHERE name = $1`, [EMBED_MEMORY_QUEUE])).rows;
  const expectClean = (...extra: string[]) => {
    const dump = out.join('\n') + extra.join('\n');
    for (const s of ALL_SENTINELS) expect(dump, `leaked ${s}`).not.toContain(s);
  };

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Tag, Memory, MemoryTag]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = (await q(`INSERT INTO workspaces (name, slug) VALUES ('alpha', 'alpha') RETURNING id`))[0].id;
    admin = new Client({ connectionString: TEST_DATABASE_URL });
    await admin.connect();
    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) vi.stubEnv(k, v);
  });
  afterAll(async () => {
    await admin?.end();
    await iso?.dispose();
    vi.unstubAllEnvs();
  });

  async function boot(options: { inlineTimeoutMs?: number } = {}) {
    bossSchema = `pgboss_t_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    embeddings = new ScriptedEmbeddings();
    queue = new QueueService({ connectionString: TEST_DATABASE_URL!, schema: bossSchema, ingestionConcurrency: 2, retryDelaySeconds: 1, pollingIntervalSeconds: 0.5, stopTimeoutMs: 5000 });
    const coordinator = new MemoryEmbeddingCoordinator(ds, embeddings, queue, { similarityHint: 0.9, inlineTimeoutMs: options.inlineTimeoutMs ?? 1500, reconcileGraceMs: 0 });
    worker = new MemoryEmbeddingWorker(queue, coordinator);
    await worker.onModuleInit();
    await queue.onApplicationBootstrap();
    class FlakyTags extends TagsService {
      override async unionMemoryTags(...args: Parameters<TagsService['unionMemoryTags']>) {
        if (failTagUnion) throw new Error(`${S.db} ${S.content}`);
        return super.unionMemoryTags(...args);
      }
      override async replaceMemoryTags(...args: Parameters<TagsService['replaceMemoryTags']>) {
        if (failTagUnion) throw new Error(`${S.db} ${S.title}`);
        return super.replaceMemoryTags(...args);
      }
    }
    const store = { findByKey: async () => null, touchLastUsed: async () => true };
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [MemoriesController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: store },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        { provide: TagsService, useClass: FlakyTags },
        { provide: MEMORY_EMBEDDING_COORDINATOR, useValue: coordinator },
        MemoriesService,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  }

  beforeEach(async () => {
    failTagUnion = false;
    out.length = 0;
    const capture = (...a: unknown[]) => void out.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : String(x))).join(' '));
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) vi.spyOn(ConsoleLogger.prototype, m).mockImplementation(capture);
    for (const m of ['log', 'warn', 'error', 'debug', 'verbose', 'fatal'] as const) vi.spyOn(Logger.prototype, m).mockImplementation(capture);
    for (const m of ['log', 'warn', 'error', 'info', 'debug'] as const) vi.spyOn(console, m).mockImplementation(capture);
    const chunk = (c: unknown) => (typeof c === 'string' ? c : Buffer.from(c as Uint8Array).toString());
    vi.spyOn(process.stdout, 'write').mockImplementation(((c: unknown) => (out.push(chunk(c)), true)) as never);
    vi.spyOn(process.stderr, 'write').mockImplementation(((c: unknown) => (out.push(chunk(c)), true)) as never);
    await q('DELETE FROM memory_tags');
    await q('DELETE FROM memories');
    await q('DELETE FROM tags');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    worker?.beforeApplicationShutdown();
    await app?.close().catch(() => undefined);
    await queue?.beforeApplicationShutdown().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS "${bossSchema}" CASCADE`).catch(() => undefined);
  });

  it('keeps database query logging off', () => {
    const options = createDataSourceOptions({ databaseUrl: 'postgres://u:p@localhost:5432/x' });
    expect(options.logging).toBe(false);
  });

  it('success: create, duplicate, update, supersede, list and forget log nothing from the Memory', async () => {
    await boot();
    const a = await send('POST', w(), sentinelBody());
    expect(a.status).toBe(201);
    expect((await send('POST', w(), sentinelBody())).json.deduplicated).toBe(true);
    const b = await send('POST', w(), sentinelBody({ content: `${S.content} two` }));
    expect((await send('PUT', `${w()}/${a.json.id}`, { type: 'fact', content: `${S.content} edit`, title: S.title, metadata: { k: S.meta }, confidence: 0.5, source: S.source, tags: [S.tag] })).status).toBe(200);
    expect((await send('POST', `${w()}/${a.json.id}/supersede`, { successorId: b.json.id })).status).toBe(200);
    expect((await send('GET', `${w()}?status=all&text=${S.content}`)).status).toBe(200);
    expect((await send('DELETE', `${w()}/${b.json.id}`)).status).toBe(204);
    expectClean();
  });

  it('validation failure: bad input is rejected without echoing or logging its values', async () => {
    await boot();
    const attempts = [
      sentinelBody({ type: S.title }),
      sentinelBody({ content: '' }),
      sentinelBody({ content: S.content.repeat(600) }),
      sentinelBody({ metadata: { k: 'x'.repeat(9000), s: S.meta } }),
      sentinelBody({ confidence: S.provider }),
      sentinelBody({ [S.meta]: S.vector }),
      sentinelBody({ tags: [S.tag, { nested: S.db }] }),
    ];
    for (const body of attempts) {
      const r = await send('POST', w(), body);
      expect(r.status).toBe(400);
      expectClean(r.text);
    }
    const put = await send('PUT', `${w()}/${randomUUID()}`, { type: 'fact', content: S.content, extra: S.db });
    expect(put.status).toBe(400);
    expectClean(put.text);
    expect(Number((await q('SELECT count(*) c FROM memories'))[0].c)).toBe(0);
  });

  it('rollback: an unexpected database error returns a fixed 500, leaves no row and logs no Memory data', async () => {
    await boot();
    failTagUnion = true;
    const r = await send('POST', w(), sentinelBody());
    expect(r.status).toBe(500);
    expect(r.json).toEqual({ statusCode: 500, message: 'Internal server error' });
    expectClean(r.text);
    expect(Number((await q('SELECT count(*) c FROM memories'))[0].c)).toBe(0);
    expect(out.join('\n')).toContain('Unhandled error (Error)');
  });

  it('inline timeout: the record is saved pending, a job carries ids only, and nothing leaks', async () => {
    await boot({ inlineTimeoutMs: 100 });
    embeddings.behaviour = 'hang';
    const r = await send('POST', w(), sentinelBody());
    expect(r.status).toBe(201);
    expect(r.json.embeddingStatus).toBe('pending');
    await until(async () => (await bossRows()).length === 1);
    const jobs = await bossRows();
    expect(Object.keys(jobs[0].data).sort()).toEqual(['generation', 'memoryId', 'scope']);
    expectClean(JSON.stringify(jobs));
    embeddings.behaviour = 'ok';
    await until(async () => (await q('SELECT embedding_status s FROM memories'))[0].s === 'ready');
    expectClean(JSON.stringify(await bossRows()));
  });

  it.each(['fail', 'driver-fail', 'bad-vector'] as const)('exhausted retry (%s): ends failed with only safe diagnostics in logs and job rows', async (behaviour) => {
    await boot();
    embeddings.behaviour = behaviour;
    const r = await send('POST', w(), sentinelBody());
    expect(r.status).toBe(201);
    expect(r.json.embeddingStatus).toBe('pending');
    await until(async () => (await q('SELECT embedding_status s FROM memories'))[0].s === 'failed');
    await until(async () => (await bossRows()).some((j) => j.state === 'failed'));
    const jobs = await bossRows();
    expect(jobs).toHaveLength(1);
    const row = (await q('SELECT * FROM memories'))[0];
    const stored = JSON.stringify({ jobs, row: { ...row, content: undefined, title: undefined, metadata: undefined, source: undefined, content_hash: undefined } });
    expectClean(stored);
    // The retry endpoint's own failure path is clean as well.
    const again = await send('POST', `${w()}/${r.json.id}/retry-embedding`);
    expect(again.status).toBe(202);
    await until(async () => (await q('SELECT embedding_status s FROM memories'))[0].s === 'failed', 30_000);
    await until(async () => (await bossRows()).filter((j) => j.state === 'failed').length === 2, 30_000);
    expectClean(JSON.stringify(await bossRows()));
  });
});
