import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { ApiKeyStore } from '../src/api-keys/api-key.store.js';
import { ApiKey } from '../src/api-keys/api-key.entity.js';
import { createApp } from '../src/app.setup.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AuthorizationService } from '../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../src/auth/login-rate-limiter.js';
import { SESSION_COOKIE_NAME } from '../src/auth/session-token.js';
import { SessionGuard } from '../src/auth/session.guard.js';
import { CollectionsController } from '../src/collections/collections.controller.js';
import { CollectionsService } from '../src/collections/collection.service.js';
import { Collection } from '../src/collections/collection.entity.js';
import { SanitizedExceptionFilter } from '../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../src/config/config.module.js';
import { FileRecord } from '../src/files/file.entity.js';
import { FileTag } from '../src/tags/file-tag.entity.js';
import { Tag } from '../src/tags/tag.entity.js';
import { Workspace } from '../src/workspaces/workspace.entity.js';
import { TEST_ADMIN_ENV } from './fixtures/admin.js';
import {
  TEST_DATABASE_URL,
  assertDisposableDatabase,
  createIsolatedSchema,
  describeIntegration,
  type IsolatedSchema,
} from './helpers/integration.js';

/** AC-6/AC-8 for Collections against real PostgreSQL with the production guard and authorization service. */
describeIntegration('Collections API (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let app: INestApplication;
  let base: string;
  let adminCookie: string;
  let wsA: string;
  let wsB: string;
  const keys = new Map<string, { workspaceId: string; permissions: Permission[] }>();
  let seq = 0;

  const bearer = (workspaceId: string, permissions: Permission[]) => {
    const key = `sk_seshat_TestKey${++seq}_secret${'x'.repeat(40)}`;
    keys.set(key, { workspaceId, permissions });
    return key;
  };

  async function req(method: string, path: string, body?: unknown, auth: { key?: string; cookie?: string | null } = {}) {
    const headers: Record<string, string> = {};
    if (auth.key) headers.authorization = `Bearer ${auth.key}`;
    else if (auth.cookie !== null) headers.cookie = auth.cookie ?? adminCookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json };
  }

  const g = '/api/global/collections';
  const w = (id: string) => `/api/workspaces/${id}/collections`;
  const addFile = async (workspaceId: string | null, collectionId: string | null) => {
    seq += 1;
    await ds.query(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key, collection_id)
       VALUES ($1, $2, 'a.txt', 'txt', 'text/plain', 1, $3, $4, $5)`,
      [workspaceId ? 'workspace' : 'global', workspaceId, 'a'.repeat(64), `k/${seq}/${randomUUID()}`, collectionId],
    );
  };
  const addWorkspace = async (slug: string) =>
    ((await ds.query('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug])) as { id: string }[])[0]!.id;

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource([Workspace, ApiKey, Collection, Tag, FileTag, FileRecord]);
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    wsA = await addWorkspace('alpha');
    wsB = await addWorkspace('beta');

    for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
      vi.stubEnv(k, v);
    }
    const store = {
      findByKey: async (presented: string) => {
        const k = keys.get(presented);
        if (!k) return null;
        return {
          id: randomUUID(),
          workspaceId: k.workspaceId,
          name: 'k',
          prefix: 'TestKey00',
          permissions: k.permissions,
          createdAt: new Date(),
          expiresAt: null,
          lastUsedAt: null,
          revokedAt: null,
        };
      },
      touchLastUsed: async () => true,
    };
    @Module({
      imports: [ConfigModule, EventEmitterModule.forRoot()],
      controllers: [CollectionsController],
      providers: [
        { provide: CLOCK, useValue: systemClock },
        AuthService,
        SessionGuard,
        { provide: APP_GUARD, useExisting: SessionGuard },
        { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
        { provide: ApiKeyStore, useValue: store },
        AuthorizationService,
        { provide: getDataSourceToken(), useValue: ds },
        CollectionsService,
      ],
    })
    class TestRoot {}
    app = await createApp(TestRoot, { trustProxy: false }, false);
    await app.listen(0, '127.0.0.1');
    base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  });

  afterAll(async () => {
    await app?.close();
    await iso?.dispose();
    vi.unstubAllEnvs();
  });

  it('creates, reads, renames and deletes in Global and in a Workspace, returning DTOs only', async () => {
    for (const path of [g, w(wsA)]) {
      const created = await req('POST', path, { name: '  Reports ', description: ' Q1 ' });
      expect(created.status).toBe(201);
      expect(Object.keys(created.json).sort()).toEqual(['createdAt', 'description', 'fileCount', 'id', 'name', 'updatedAt']);
      expect(created.json).toMatchObject({ name: 'Reports', description: 'Q1', fileCount: 0 });
      const id = created.json.id as string;
      expect((await req('GET', `${path}/${id}`)).json).toMatchObject({ id, name: 'Reports' });
      const renamed = await req('PATCH', `${path}/${id}`, { name: 'Renamed', description: null });
      expect(renamed.json).toMatchObject({ name: 'Renamed', description: null });
      expect((await req('PATCH', `${path}/${id}`, { description: 'only desc' })).json).toMatchObject({ name: 'Renamed', description: 'only desc' });
      expect((await req('GET', path)).json.map((c: any) => c.id)).toContain(id);
      expect((await req('DELETE', `${path}/${id}`)).status).toBe(204);
      expect((await req('GET', `${path}/${id}`)).status).toBe(404);
      expect((await req('DELETE', `${path}/${id}`)).status).toBe(404);
    }
  });

  it('validates names and strict bodies', async () => {
    for (const body of [{}, { name: '' }, { name: '   ' }, { name: 'x'.repeat(101) }, { name: 'ok', extra: 1 }, { name: 'ok', description: 'x'.repeat(2001) }, { name: 5 }]) {
      expect((await req('POST', w(wsA), body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    expect((await req('POST', w(wsA), { name: 'x'.repeat(100) })).status).toBe(201);
    const c = (await req('POST', w(wsA), { name: 'ToPatch' })).json;
    for (const body of [{}, { scope: 'global' }, { workspaceId: wsB }, { name: '' }]) {
      expect((await req('PATCH', `${w(wsA)}/${c.id}`, body)).status).toBe(400);
    }
  });

  it('enforces case-insensitive unique names per scope, also under concurrent creation', async () => {
    expect((await req('POST', w(wsA), { name: 'Docs' })).status).toBe(201);
    expect((await req('POST', w(wsA), { name: 'dOCS' })).status).toBe(409);
    // identical names in Global and the other Workspace are fine
    expect((await req('POST', w(wsB), { name: 'Docs' })).status).toBe(201);
    expect((await req('POST', g, { name: 'Docs' })).status).toBe(201);

    const results = await Promise.all(['Race', 'race', 'RACE', 'rAcE', 'Race'].map((name) => req('POST', w(wsA), { name })));
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) expect(r.text).not.toMatch(/UQ_|duplicate key|constraint/i);

    // rename collision
    const other = (await req('POST', w(wsA), { name: 'Other' })).json;
    expect((await req('PATCH', `${w(wsA)}/${other.id}`, { name: 'DOCS' })).status).toBe(409);
    expect((await req('PATCH', `${w(wsA)}/${other.id}`, { name: 'OTHER' })).status).toBe(200); // own name, different case
  });

  it('counts only same-scope files and keeps files and tags when a Collection is deleted', async () => {
    const a = (await req('POST', w(wsA), { name: 'Counted' })).json;
    const b = (await req('POST', w(wsB), { name: 'Counted' })).json;
    const gl = (await req('POST', g, { name: 'Counted' })).json;
    await addFile(wsA, a.id);
    await addFile(wsA, a.id);
    await addFile(wsA, null);
    await addFile(wsB, b.id);
    await addFile(null, gl.id);
    const count = async (path: string, id: string) => (await req('GET', `${path}/${id}`)).json.fileCount;
    expect(await count(w(wsA), a.id)).toBe(2);
    expect(await count(w(wsB), b.id)).toBe(1);
    expect(await count(g, gl.id)).toBe(1);
    expect((await req('GET', w(wsA))).json.find((c: any) => c.id === a.id).fileCount).toBe(2);

    // tag one file of A, then delete the Collection
    const tagId = ((await ds.query(`INSERT INTO tags (scope, workspace_id, name) VALUES ('workspace', $1, 'keep') RETURNING id`, [wsA])) as { id: string }[])[0]!.id;
    const fileId = ((await ds.query('SELECT id FROM files WHERE collection_id = $1 LIMIT 1', [a.id])) as { id: string }[])[0]!.id;
    await ds.query('INSERT INTO file_tags (file_id, tag_id, scope_key) VALUES ($1, $2, $3)', [fileId, tagId, wsA]);

    expect((await req('DELETE', `${w(wsA)}/${a.id}`)).status).toBe(204);
    const files = (await ds.query('SELECT collection_id FROM files WHERE scope_key = $1', [wsA])) as { collection_id: string | null }[];
    expect(files).toHaveLength(3);
    expect(files.every((f) => f.collection_id === null)).toBe(true);
    expect(await ds.query('SELECT 1 FROM file_tags WHERE file_id = $1', [fileId])).toHaveLength(1);
    // other scopes untouched
    expect(await count(w(wsB), b.id)).toBe(1);
    expect(await count(g, gl.id)).toBe(1);
  });

  it('answers a foreign or missing resource with the same generic 404', async () => {
    const inA = (await req('POST', w(wsA), { name: 'ForeignProbe' })).json;
    const missing = randomUUID();
    const calls: [string, (id: string) => string, unknown?][] = [
      ['GET', (id) => `${w(wsB)}/${id}`],
      ['PATCH', (id) => `${w(wsB)}/${id}`, { name: 'x' }],
      ['DELETE', (id) => `${w(wsB)}/${id}`],
      ['GET', (id) => `${g}/${id}`],
      ['PATCH', (id) => `${g}/${id}`, { name: 'x' }],
      ['DELETE', (id) => `${g}/${id}`],
    ];
    for (const [m, path, body] of calls) {
      const foreign = await req(m, path(inA.id), body);
      const absent = await req(m, path(missing), body);
      expect(foreign.status, `${m} ${path(inA.id)}`).toBe(404);
      expect({ status: foreign.status, text: foreign.text }).toEqual({ status: absent.status, text: absent.text });
    }
    // not-a-uuid id behaves like a missing one; the Collection still exists
    expect((await req('GET', `${w(wsA)}/not-a-uuid`)).status).toBe(404);
    expect((await req('GET', `${w(wsA)}/${inA.id}`)).status).toBe(200);
    // a Workspace that does not exist
    const ghost = randomUUID();
    expect((await req('GET', w(ghost))).status).toBe(404);
    expect((await req('POST', w(ghost), { name: 'x' })).status).toBe(404);
  });

  it('membership validation gives one 400 for unknown, other-scope and malformed ids and never reads foreign rows', async () => {
    const own = (await req('POST', w(wsA), { name: 'Member' })).json;
    const foreignWs = (await req('POST', w(wsB), { name: 'ForeignMember' })).json;
    const foreignGlobal = (await req('POST', g, { name: 'GlobalMember' })).json;
    const service = app.get(CollectionsService);
    const scopeA = { kind: 'workspace', workspaceId: wsA } as const;
    const failures: string[] = [];
    await ds.transaction(async (m) => {
      expect(await service.resolveMembership(m, scopeA, own.id)).toBe(own.id);
      expect(await service.resolveMembership(m, scopeA, undefined)).toBeNull();
      expect(await service.resolveMembership(m, scopeA, null)).toBeNull();
      for (const id of [randomUUID(), foreignWs.id, foreignGlobal.id, 'nope', '']) {
        const err = await service.resolveMembership(m, scopeA, id).then(() => null, (e: any) => e);
        expect(err?.getStatus?.(), id).toBe(400);
        failures.push(JSON.stringify(err.getResponse()));
      }
      // and the other way around: Global cannot use a Workspace Collection
      const err = await service.resolveMembership(m, { kind: 'global' }, own.id).then(() => null, (e: any) => e);
      expect(err?.getStatus?.()).toBe(400);
      failures.push(JSON.stringify(err.getResponse()));
    });
    expect(new Set(failures).size).toBe(1);
  });

  it('authorizes through AuthorizationService: permissions, other Workspaces and ungranted Global', async () => {
    const c = (await req('POST', w(wsA), { name: 'PermProbe' })).json;
    const gc = (await req('POST', g, { name: 'GlobalPermProbe' })).json;
    const reader = bearer(wsA, ['collections:read']);
    const writer = bearer(wsA, ['collections:write']);
    const none = bearer(wsA, ['files:read']);
    const globalReader = bearer(wsA, ['collections:read', 'global:read']);
    const missing = randomUUID();

    // reads need collections:read, mutations collections:write; the 403 names only the permission
    expect((await req('GET', w(wsA), undefined, { key: reader })).status).toBe(200);
    expect((await req('GET', `${w(wsA)}/${c.id}`, undefined, { key: reader })).status).toBe(200);
    const denied = await req('POST', w(wsA), { name: 'Nope' }, { key: reader });
    expect(denied.status).toBe(403);
    expect(denied.text).toContain('collections:write');
    expect((await req('PATCH', `${w(wsA)}/${c.id}`, { name: 'Nope' }, { key: reader })).status).toBe(403);
    expect((await req('DELETE', `${w(wsA)}/${c.id}`, undefined, { key: reader })).status).toBe(403);
    expect((await req('GET', w(wsA), undefined, { key: writer })).status).toBe(403);
    expect((await req('GET', w(wsA), undefined, { key: none })).status).toBe(403);
    expect((await req('GET', `${w(wsA)}/${missing}`, undefined, { key: none })).status).toBe(403); // authz before lookup
    expect((await req('POST', w(wsA), { name: 'ByWriter' }, { key: writer })).status).toBe(201);
    expect((await req('GET', `${w(wsA)}/${c.id}`, undefined, { key: reader })).json.name).toBe('PermProbe'); // untouched

    // another Workspace: identical to a missing one, whatever the permissions
    const other = await req('GET', `${w(wsB)}/${c.id}`, undefined, { key: reader });
    const absent = await req('GET', `${w(randomUUID())}/${c.id}`, undefined, { key: reader });
    expect(other.status).toBe(404);
    expect({ status: other.status, text: other.text }).toEqual({ status: absent.status, text: absent.text });
    expect((await req('GET', w(wsB), undefined, { key: reader })).status).toBe(404);
    expect((await req('POST', w(wsB), { name: 'x' }, { key: writer })).status).toBe(404);

    // Global without the grant is the generic 404 (same as a missing Global Collection); with the grant reads work
    const hidden = await req('GET', `${g}/${gc.id}`, undefined, { key: reader });
    const hiddenMissing = await req('GET', `${g}/${missing}`, undefined, { key: reader });
    expect(hidden.status).toBe(404);
    expect({ status: hidden.status, text: hidden.text }).toEqual({ status: hiddenMissing.status, text: hiddenMissing.text });
    expect((await req('GET', g, undefined, { key: reader })).status).toBe(404);
    expect((await req('GET', g, undefined, { key: globalReader })).status).toBe(200);
    expect((await req('GET', `${g}/${gc.id}`, undefined, { key: globalReader })).status).toBe(200);
    // no key ever mutates Global
    const allGrants = bearer(wsA, ['collections:read', 'collections:write', 'global:read']);
    expect((await req('POST', g, { name: 'x' }, { key: allGrants })).status).toBe(403);
    expect((await req('PATCH', `${g}/${gc.id}`, { name: 'x' }, { key: allGrants })).status).toBe(403);
    expect((await req('DELETE', `${g}/${gc.id}`, undefined, { key: allGrants })).status).toBe(403);
    expect((await req('POST', g, { name: 'x' }, { key: writer })).status).toBe(404);
    expect((await req('GET', `${g}/${gc.id}`, undefined, { cookie: adminCookie })).status).toBe(200);

    // Collection ownership grants nothing: no session, no access
    expect((await req('GET', w(wsA), undefined, { cookie: null })).status).toBe(401);
  });
});
