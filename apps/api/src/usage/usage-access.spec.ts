import 'reflect-metadata';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ChunksService } from '../ingestion/chunks.service.js';
import { FilesService } from '../files/files.service.js';
import { McpService } from '../mcp/mcp.service.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from '../mcp/mcp-registry.js';
import { emittedResourceKeys, renderedItem } from '../mcp/mcp-results.js';
import { MemoriesService } from '../memories/memories.service.js';
import { RelatedMemoriesService } from '../search/related.service.js';
import { SearchService } from '../search/search.service.js';
import { UsageAccessInterceptor } from './usage-access.interceptor.js';
import { UsageCollector } from './usage-request-context.js';
import { retrievedRefsOf } from './usage-staging.js';

const WS = '11111111-1111-4111-8111-111111111111';
const F1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const F2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const M1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const M2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ws = { kind: 'workspace', workspaceId: WS } as const;
const global = { kind: 'global' } as const;
const principal = { kind: 'admin' } as never;

type Channel = 'ui' | 'api' | 'mcp';
const CHANNELS: Channel[] = ['ui', 'api', 'mcp'];

function harness() {
  const enqueued: { resourceKind: string; resourceId: string; scope: unknown; channel: string; accessKind: string }[] = [];
  const recorder = { enqueueAccess: vi.fn((a: (typeof enqueued)[number]) => void enqueued.push(a)) };
  const usage = new UsageCollector(recorder as never);
  const summary = () => enqueued.map((a) => `${a.channel}:${a.accessKind}:${a.resourceKind}:${a.resourceId}:${a.scope.kind === 'global' ? 'global' : a.scope.workspaceId}`).sort();
  return { usage, enqueued, recorder, summary };
}

const allow = { assertCan: () => undefined, authorizeSearch: () => ({ scopes: [ws], types: ['files', 'memories'] }) };
const deny = { assertCan: () => { throw new ForbiddenException(); }, authorizeSearch: () => { throw new ForbiddenException(); } };

const fileRow = (id: string) => ({
  id, scope: 'workspace', workspace_id: WS, name: 'n', extension: null, mime_type: 'text/plain', size_bytes: 1, sha256: 'x', collection_id: null,
  ingestion_status: 'indexed', ingestion_error: null, indexed_at: null, chunk_count: 0, created_by_kind: null, created_by_key_id: null,
  created_by_key_name: null, client_name: null, client_version: null, created_at: new Date(), updated_at: new Date(), storage_key: 'k',
});

function filesService(usage: UsageCollector, authz: unknown = allow, missing = false) {
  const svc = new FilesService(
    { query: async () => [] } as never, authz as never, { get: async () => Readable.from(['x']) } as never,
    {} as never, {} as never, {} as never, {} as never, { maxUploadBytes: 1 } as never, usage,
  );
  Object.assign(svc, {
    findRow: async (_s: unknown, id: string) => {
      if (missing) throw new NotFoundException('Not Found');
      return fileRow(id);
    },
    tagNamesFor: async () => new Map(),
  });
  return svc;
}

function chunksService(usage: UsageCollector, authz: unknown = allow, exists = true) {
  const ds = { query: vi.fn(async (sql: string) => (/FROM "files"/.test(sql) ? (exists ? [{}] : []) : [])) };
  return new ChunksService(ds as never, authz as never, usage);
}

function memoriesService(usage: UsageCollector, authz: unknown = allow) {
  const svc = new MemoriesService({ manager: {}, query: async () => [{}] } as never, authz as never, {} as never, undefined, usage);
  Object.assign(svc, { load: async (_m: unknown, _k: string, id: string) => ({ id }) });
  return svc;
}

const chunkResult = (fileId: string, scope: unknown = { kind: 'workspace', id: WS, slug: 's' }) => ({ kind: 'chunk', id: `chunk-${Math.random()}`, file: { id: fileId, name: 'n' }, collectionId: null, ordinal: 0, location: { startLine: 1, endLine: 1 }, scope, content: 'secret text', score: 1 });
const memoryResult = (id: string, scope: unknown = { kind: 'workspace', id: WS, slug: 's' }) => ({ kind: 'memory', id, scope, memoryType: 'fact', title: null, content: 'secret memory', score: 1 });

function searchService(usage: UsageCollector, results: unknown[], authz: unknown = allow) {
  const retrieval = { retrieve: vi.fn(async () => ({ results })) };
  const ds = { query: async () => [{}] };
  return new SearchService(authz as never, retrieval as never, ds as never, usage);
}
const searchBody = { query: 'q', types: ['files', 'memories'], tagMatch: 'any', includeSuperseded: false, limit: 10, includeGlobal: true } as never;

function relatedService(usage: UsageCollector, opts: { seedVector: number[] | null; found?: boolean; results?: { id: string; scope?: unknown }[] }) {
  const results = opts.results ?? [];
  const svc = new RelatedMemoriesService(
    allow as never,
    { transaction: async (fn: (m: unknown) => unknown) => fn({}), query: async () => [{}] } as never,
    { vectorVersion: async () => '0.8.0' } as never,
    usage,
  );
  const row = (r: { id: string }) => ({ id: r.id, content: 'c', scope: { kind: 'workspace', id: WS, slug: 's' }, type: 'fact', title: null, tags: [], status: 'active', confidence: null, source: null, createdByKind: 'admin', createdByKeyId: null, createdByKeyName: null, clientName: null, clientVersion: null, updatedAt: new Date() });
  Object.assign(svc, {
    repo: {
      loadSeedVector: async () => (opts.found === false ? null : { id: M1, vector: opts.seedVector }),
      applyAnnSettings: async () => undefined,
      nearestMemories: async () => results.map((r) => ({ id: r.id, distance: 0.1 })),
      loadMemories: async () => new Map(results.map((r) => [r.id, row(r)])),
    },
  });
  return svc;
}

/** Runs `fn` as a request on `channel` that finishes successfully, so staged accesses are committed. */
async function succeeds<T>(usage: UsageCollector, channel: Channel, fn: () => Promise<T>): Promise<T> {
  return usage.run(channel, async (ctx) => {
    const out = await fn();
    usage.commit(ctx);
    return out;
  });
}

describe('qualifying operations count, per channel and scope', () => {
  const cases: { name: string; run: (u: UsageCollector) => Promise<unknown>; expected: (c: Channel) => string[] }[] = [
    { name: 'GET file metadata', run: (u) => filesService(u).get(principal, ws, F1), expected: (c) => [`${c}:read:file:${F1}:${WS}`] },
    { name: 'GET Global file metadata', run: (u) => filesService(u).get(principal, global, F1), expected: (c) => [`${c}:read:file:${F1}:global`] },
    {
      name: 'GET file download',
      run: async (u) => void (await filesService(u).openDownload(principal, ws, F1)),
      expected: (c) => [`${c}:read:file:${F1}:${WS}`],
    },
    { name: 'GET file chunks', run: (u) => chunksService(u).list(principal, ws, F1, {}), expected: (c) => [`${c}:read:file:${F1}:${WS}`] },
    { name: 'GET memory', run: (u) => memoriesService(u).get(principal, ws, M1), expected: (c) => [`${c}:read:memory:${M1}:${WS}`] },
    { name: 'GET Global memory', run: (u) => memoriesService(u).get(principal, global, M1), expected: (c) => [`${c}:read:memory:${M1}:global`] },
    {
      name: 'related: seed read, returned results retrieved',
      run: (u) => relatedService(u, { seedVector: [1], results: [{ id: M2 }] }).related(principal, ws, M1, { limit: 5 } as never),
      expected: (c) => [`${c}:read:memory:${M1}:${WS}`, `${c}:retrieved:memory:${M2}:${WS}`],
    },
    {
      name: 'related: seed without embedding is still a read',
      run: (u) => relatedService(u, { seedVector: null }).related(principal, ws, M1, { limit: 5 } as never),
      expected: (c) => [`${c}:read:memory:${M1}:${WS}`],
    },
    {
      name: 'search: chunks of one file count once; Global result attributed to Global',
      run: (u) =>
        searchService(u, [chunkResult(F1), chunkResult(F1), memoryResult(M1), memoryResult(M2, { kind: 'global' }), chunkResult(F2, { kind: 'global' })]).search(principal, ws, searchBody),
      expected: (c) => [`${c}:retrieved:file:${F1}:${WS}`, `${c}:retrieved:file:${F2}:global`, `${c}:retrieved:memory:${M1}:${WS}`, `${c}:retrieved:memory:${M2}:global`],
    },
  ];

  for (const c of cases) {
    for (const channel of CHANNELS) {
      it(`${c.name} (${channel})`, async () => {
        const h = harness();
        await succeeds(h.usage, channel, () => c.run(h.usage));
        expect(h.summary()).toEqual(c.expected(channel).sort());
      });
    }
  }

  it('nothing is recorded without a request context (system reads) or before commit', async () => {
    const h = harness();
    await filesService(h.usage).get(principal, ws, F1);
    await h.usage.run('api', async () => void (await filesService(h.usage).get(principal, ws, F1)));
    expect(h.recorder.enqueueAccess).not.toHaveBeenCalled();
  });

  it('get + get of the same resource in one request counts once', async () => {
    const h = harness();
    await succeeds(h.usage, 'api', async () => {
      await filesService(h.usage).get(principal, ws, F1);
      await filesService(h.usage).get(principal, ws, F1);
      await chunksService(h.usage).list(principal, ws, F1, {});
    });
    expect(h.summary()).toEqual([`api:read:file:${F1}:${WS}`]);
  });
});

describe('context counts only the sources it cites', () => {
  it('budget-excluded results and the intermediate search do not count', async () => {
    const h = harness();
    // Tiny budget: the first section may not fit at all or only the first fits; everything else is dropped.
    const results = [chunkResult(F1), chunkResult(F2), memoryResult(M1), memoryResult(M2)].map((r, i) => ({ ...r, content: 'word '.repeat(300 + i) }));
    const svc = searchService(h.usage, results);
    const ctx = await succeeds(h.usage, 'api', () => svc.context(principal, ws, { ...(searchBody as object), maxChars: 1800 } as never));
    const cited = ctx.sources.map((s) => (s.kind === 'chunk' ? `file:${s.file.id}` : `memory:${s.id}`));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.length).toBeLessThan(4);
    const counted = h.enqueued.map((a) => `${a.resourceKind}:${a.resourceId}`);
    expect(counted.sort()).toEqual(cited.sort());
  });

  it('a result the formatter skips (no content) is not cited and counts nothing', async () => {
    const h = harness();
    const ctx = await succeeds(h.usage, 'api', () => searchService(h.usage, [{ ...chunkResult(F1), content: '  ' }]).context(principal, ws, { ...(searchBody as object), maxChars: 2000 } as never));
    expect(ctx.sources).toHaveLength(0);
    expect(h.recorder.enqueueAccess).not.toHaveBeenCalled();
  });
});

describe('failed, denied and missing requests count zero', () => {
  const failing: [string, (u: UsageCollector) => Promise<unknown>][] = [
    ['denied file get', (u) => filesService(u, deny).get(principal, ws, F1)],
    ['unknown file', (u) => filesService(u, allow, true).get(principal, ws, F1)],
    ['denied download', (u) => filesService(u, deny).openDownload(principal, ws, F1)],
    ['unknown file chunks', (u) => chunksService(u, allow, false).list(principal, ws, F1, {})],
    ['denied chunks', (u) => chunksService(u, deny).list(principal, ws, F1, {})],
    ['denied memory get', (u) => memoriesService(u, deny).get(principal, ws, M1)],
    ['malformed memory id', (u) => memoriesService(u).get(principal, ws, 'nope')],
    ['denied search', (u) => searchService(u, [memoryResult(M1)], deny).search(principal, ws, searchBody)],
    ['related with unknown seed', (u) => relatedService(u, { seedVector: [1], found: false }).related(principal, ws, M1, { limit: 5 } as never)],
  ];
  for (const [name, run] of failing) {
    it(name, async () => {
      const h = harness();
      await expect(succeeds(h.usage, 'api', () => run(h.usage))).rejects.toBeDefined();
      expect(h.recorder.enqueueAccess).not.toHaveBeenCalled();
    });
  }

  it('a request that staged an access and then failed is discarded', async () => {
    const h = harness();
    await h.usage.run('api', async (ctx) => {
      await filesService(h.usage).get(principal, ws, F1);
      h.usage.discard(ctx);
      h.usage.commit(ctx);
    });
    expect(h.recorder.enqueueAccess).not.toHaveBeenCalled();
  });
});

describe('only the allowlisted read sites stage accesses (lists, writes, deletes, ingestion never do)', () => {
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
    });
  it('stage calls exist in exactly the expected methods', () => {
    const sites: string[] = [];
    for (const file of walk(root)) {
      if (file.includes('/usage/')) continue;
      const src = readFileSync(file, 'utf8');
      const lines = src.split('\n');
      let method = '';
      for (const line of lines) {
        const m = /^  (?:async |private async |private |public )?([a-zA-Z]+)\(/.exec(line);
        if (m && !/^\s{4}/.test(line)) method = m[1]!;
        if (/usage\??\.stage\(|stageRetrieved\(/.test(line) && !line.includes('import')) sites.push(`${file.replace(root, '')}#${method}`);
      }
    }
    expect(sites.sort()).toEqual(
      [
        'files/files.service.ts#get',
        'files/files.service.ts#openDownload',
        'ingestion/chunks.service.ts#list',
        'memories/memories.service.ts#get',
        'search/related.service.ts#related',
        'search/related.service.ts#related',
        'search/search.service.ts#search',
        'search/search.service.ts#context',
      ].sort(),
    );
  });
});

describe('transport boundary (interceptor)', () => {
  function run(opts: { statusCode: number; events: ('finish' | 'close')[]; path?: string; kind?: 'admin' | 'apiKey'; handlerStages?: boolean; recorderThrows?: boolean }) {
    const h = harness();
    if (opts.recorderThrows) h.recorder.enqueueAccess.mockImplementation(() => { throw new Error('boom'); });
    const listeners = new Map<string, () => void>();
    const res = { statusCode: opts.statusCode, once: (e: string, l: () => void) => void listeners.set(e, l) };
    const req = { path: opts.path ?? '/api/workspaces/x/files/y', principal: { kind: opts.kind ?? 'admin' } };
    const ctx = { getType: () => 'http', switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) };
    const interceptor = new UsageAccessInterceptor(h.usage);
    const next = {
      handle: () => {
        if (opts.handlerStages !== false) h.usage.stage({ resourceKind: 'file', resourceId: F1, scope: ws, accessKind: 'read' });
        return of('ok');
      },
    };
    return lastValueFrom(interceptor.intercept(ctx as never, next as never)).then((value) => {
      for (const e of opts.events) listeners.get(e)?.();
      return { h, value };
    });
  }

  it('commits on a finished 2xx response with channel ui for the admin and api for a key', async () => {
    expect((await run({ statusCode: 200, events: ['finish', 'close'] })).h.summary()).toEqual([`ui:read:file:${F1}:${WS}`]);
    expect((await run({ statusCode: 200, kind: 'apiKey', events: ['finish', 'close'] })).h.summary()).toEqual([`api:read:file:${F1}:${WS}`]);
  });

  it.each([404, 403, 500, 302])('discards a %s response', async (statusCode) => {
    expect((await run({ statusCode, events: ['finish', 'close'] })).h.enqueued).toHaveLength(0);
  });

  it('discards an aborted response (client closed before finish, e.g. a dropped download)', async () => {
    expect((await run({ statusCode: 200, events: ['close'] })).h.enqueued).toHaveLength(0);
  });

  it('leaves /mcp to its own boundary', async () => {
    expect((await run({ statusCode: 200, path: '/mcp', events: ['finish'], handlerStages: false })).h.enqueued).toHaveLength(0);
  });

  it('recording failure leaves the response untouched', async () => {
    const { value } = await run({ statusCode: 200, events: ['finish'], recorderThrows: true });
    expect(value).toBe('ok');
  });
});

describe('MCP result capping counts only emitted resources', () => {
  const big = (id: string, n: number) => ({ kind: 'chunk', id: `c-${id}`, file: { id }, content: 'x'.repeat(n) });
  const outputOf = (items: ReturnType<typeof big>[]) => ({
    structured: { results: items },
    emitted: items.map((i) => ({ resourceKind: 'file' as const, resourceId: i.file.id, probe: renderedItem(i) })),
  });

  it('all resources when the structured content fits', () => {
    const o = outputOf([big(F1, 10), big(F2, 10)]);
    expect([...emittedResourceKeys(o, 10_000)].sort()).toEqual([`file|${F1}`, `file|${F2}`]);
  });

  it('only fully rendered items when structured content is replaced and the text is cut', () => {
    const o = outputOf([big(F1, 100), big(F2, 5000)]);
    expect([...emittedResourceKeys(o, 600)]).toEqual([`file|${F1}`]);
  });

  it('nothing when no item fits the capped text', () => {
    expect(emittedResourceKeys(outputOf([big(F1, 5000)]), 300).size).toBe(0);
  });

  it('retrievedRefsOf dedupes chunks per file and maps scopes', () => {
    const refs = retrievedRefsOf([chunkResult(F1), chunkResult(F1), memoryResult(M1, { kind: 'global' })] as never);
    expect(refs).toEqual([
      { resourceKind: 'file', resourceId: F1, scope: ws },
      { resourceKind: 'memory', resourceId: M1, scope: global },
    ]);
  });

  async function callTool(output: unknown, opts: { fail?: boolean; max: number }) {
    const h = harness();
    const registry = new McpToolRegistry();
    registry.register({
      name: 'probe_tool', description: 'd', inputSchema: (await import('zod')).z.strictObject({}), kind: 'read', requires: { allOf: [] } as never, actions: [],
      handler: async () => {
        h.usage.stage({ resourceKind: 'file', resourceId: F1, scope: ws, accessKind: 'retrieved' });
        h.usage.stage({ resourceKind: 'file', resourceId: F2, scope: ws, accessKind: 'retrieved' });
        if (opts.fail) throw new Error('internal');
        return output as never;
      },
    });
    const svc = new McpService(registry, allow as never, { mcpMaxResultChars: opts.max }, h.usage);
    const p = { kind: 'apiKey', workspaceId: WS, permissions: [] } as never;
    await h.usage.run('mcp', async (ctx) => {
      await svc.callTool(p, 'probe_tool', {}, null);
      h.usage.commit(ctx);
    });
    return h;
  }

  it('truncated MCP results count only what was emitted', async () => {
    const h = await callTool(outputOf([big(F1, 100), big(F2, 5000)]), { max: 600 });
    expect(h.summary()).toEqual([`mcp:retrieved:file:${F1}:${WS}`]);
  });

  it('untruncated MCP results count everything staged', async () => {
    const h = await callTool(outputOf([big(F1, 10), big(F2, 10)]), { max: 100_000 });
    expect(h.enqueued).toHaveLength(2);
  });

  it('a failing tool counts nothing', async () => {
    const h = await callTool({}, { fail: true, max: 1000 });
    expect(h.enqueued).toHaveLength(0);
  });

  it('MCP_TOOL_REGISTRY token is exported', () => expect(MCP_TOOL_REGISTRY).toBeDefined());
});
