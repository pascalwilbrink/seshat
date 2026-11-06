import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataSource } from 'typeorm';
import { UsagePersistenceError, UsagePersistenceService } from '../src/usage/usage-persistence.service.js';
import { UsageRetentionService, utcCutoff } from '../src/usage/usage-retention.service.js';
import type { McpCallRecord, ResourceAccessIncrement } from '../src/usage/usage-batch.js';
import { TEST_DATABASE_URL, assertDisposableDatabase, createIsolatedSchema, describeIntegration, type IsolatedSchema } from './helpers/integration.js';
import { memoryContentHash } from '../src/memories/memory-content.js';

const SENTINEL = 'SENTINEL-query-9f3a';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describeIntegration('usage storage (real PostgreSQL)', () => {
  let iso: IsolatedSchema;
  let ds: DataSource;
  let persist: UsagePersistenceService;
  let retention: UsageRetentionService;
  let wsA: string;
  let wsB: string;
  let n = 0;

  const q = (sql: string, params: unknown[] = []) => ds.query(sql, params) as Promise<Record<string, any>[]>;
  const count = async (table: string, where = 'true', params: unknown[] = []) =>
    Number((await q(`SELECT count(*) c FROM "${table}" WHERE ${where}`, params))[0]!.c);
  const scopeOf = (ws: string | null) => (ws ? ({ kind: 'workspace', workspaceId: ws } as const) : ({ kind: 'global' } as const));

  const addWorkspace = async (slug: string) => (await q('INSERT INTO workspaces (name, slug) VALUES ($1, $1) RETURNING id', [slug]))[0]!.id as string;
  const addFile = async (ws: string | null) => {
    n += 1;
    return (await q(
      `INSERT INTO files (scope, workspace_id, name, extension, mime_type, size_bytes, sha256, storage_key)
       VALUES ($1, $2, $3, 'md', 'text/markdown', 1, $4, $5) RETURNING id`,
      [ws ? 'workspace' : 'global', ws, `f${n}.md`, sha(`f${n}`), `k/${n}/${Math.random()}`],
    ))[0]!.id as string;
  };
  const addMemory = async (ws: string | null) => {
    n += 1;
    const content = `memory ${n}`;
    return (await q(
      `INSERT INTO memories (scope, workspace_id, type, content, created_by_kind, content_hash) VALUES ($1, $2, 'fact', $3, 'admin', $4) RETURNING id`,
      [ws ? 'workspace' : 'global', ws, content, memoryContentHash(content)],
    ))[0]!.id as string;
  };
  const addKey = async (ws: string, name: string) =>
    (await q(
      `INSERT INTO api_keys (workspace_id, name, prefix, key_hmac, permissions) VALUES ($1, $2, $3, $4, ARRAY['files:read']) RETURNING id`,
      [ws, name, randomUUID().replace(/-/g, '').slice(0, 8), Buffer.alloc(32, 1)],
    ))[0]!.id as string;

  const T0 = new Date('2026-11-06T10:00:00.000Z');
  const access = (kind: 'file' | 'memory', id: string, ws: string | null, over: Partial<ResourceAccessIncrement> = {}): ResourceAccessIncrement => ({
    resourceKind: kind, resourceId: id, scope: scopeOf(ws), day: '2026-11-06', channel: 'mcp', accessKind: 'read', count: 1, lastAccessedAt: T0, ...over,
  });
  const call = (ws: string, keyId: string, over: Partial<McpCallRecord> = {}): McpCallRecord => ({
    id: randomUUID(), occurredAt: T0, workspaceId: ws, keyId, keyName: 'agent key', clientName: 'claude', clientVersion: '1.0', tool: 'get_file',
    outcome: 'ok', durationMs: 12, resultChars: 340, truncated: false, argsSummary: { limit: 10, includeGlobal: false }, touched: [], ...over,
  });
  const totals = async (table: string, idCol: string, id: string) => (await q(`SELECT * FROM "${table}" WHERE "${idCol}" = $1`, [id]))[0];

  beforeAll(async () => {
    assertDisposableDatabase(TEST_DATABASE_URL!);
    iso = await createIsolatedSchema();
    await iso.query('DROP EXTENSION IF EXISTS vector');
    ds = iso.createDataSource();
    await ds.initialize();
    await ds.runMigrations({ transaction: 'each' });
    persist = new UsagePersistenceService(ds);
    retention = new UsageRetentionService(ds, { usageRetentionDays: 365, mcpCallRetentionDays: 90 });
  });
  afterAll(async () => {
    await iso?.dispose();
  });
  beforeEach(async () => {
    for (const t of ['usage_batches', 'mcp_list_daily', 'mcp_calls', 'file_usage_totals', 'file_usage_daily', 'memory_usage_totals', 'memory_usage_daily', 'files', 'memories', 'api_keys']) {
      await q(`DELETE FROM "${t}"`);
    }
    await q('DELETE FROM workspaces');
    wsA = await addWorkspace('a');
    wsB = await addWorkspace('b');
  });

  describe('counters', () => {
    it('keeps one daily row per resource, day, channel and kind and adds up lifetime totals with breakdowns', async () => {
      const file = await addFile(wsA);
      await persist.persistBatch({
        batchId: randomUUID(),
        accesses: [
          access('file', file, wsA, { count: 2 }),
          access('file', file, wsA, { count: 3 }), // same key inside one batch: aggregated, no conflict error
          access('file', file, wsA, { channel: 'ui', accessKind: 'retrieved', count: 4 }),
          access('file', file, wsA, { day: '2026-11-05', channel: 'api', count: 1 }),
        ],
      });
      await persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { count: 5 })] });

      const daily = await q('SELECT day::text, channel, access_kind, count::int FROM file_usage_daily WHERE file_id = $1 ORDER BY day, channel, access_kind', [file]);
      expect(daily).toEqual([
        { day: '2026-11-05', channel: 'api', access_kind: 'read', count: 1 },
        { day: '2026-11-06', channel: 'mcp', access_kind: 'read', count: 10 },
        { day: '2026-11-06', channel: 'ui', access_kind: 'retrieved', count: 4 },
      ]);
      expect(await totals('file_usage_totals', 'file_id', file)).toMatchObject({
        total_count: '15', read_count: '11', retrieved_count: '4', ui_count: '4', api_count: '1', mcp_count: '10', scope: 'workspace', workspace_id: wsA,
      });
    });

    it('stores Memories the same way and Global resources with a null Workspace', async () => {
      const memory = await addMemory(null);
      const file = await addFile(null);
      await persist.persistBatch({ batchId: randomUUID(), accesses: [access('memory', memory, null, { accessKind: 'retrieved' }), access('file', file, null, { channel: 'api' })] });
      expect(await totals('memory_usage_totals', 'memory_id', memory)).toMatchObject({ scope: 'global', workspace_id: null, scope_key: 'global', total_count: '1', retrieved_count: '1', mcp_count: '1' });
      expect(await totals('file_usage_totals', 'file_id', file)).toMatchObject({ scope: 'global', workspace_id: null, api_count: '1' });
      expect(await count('memory_usage_daily')).toBe(1);
    });

    it('moves last_accessed_at forward only', async () => {
      const file = await addFile(wsA);
      const late = new Date('2026-11-06T12:00:00.000Z');
      await persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { lastAccessedAt: late })] });
      await persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { lastAccessedAt: T0 })] });
      expect((await totals('file_usage_totals', 'file_id', file))!.last_accessed_at.toISOString()).toBe(late.toISOString());
      const later = new Date('2026-11-06T13:00:00.000Z');
      await persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { lastAccessedAt: later })] });
      expect((await totals('file_usage_totals', 'file_id', file))!.last_accessed_at.toISOString()).toBe(later.toISOString());
    });

    it('replaying a committed batch (including after an uncertain commit) increments nothing twice', async () => {
      const file = await addFile(wsA);
      const key = await addKey(wsA, 'k');
      const batch = {
        batchId: randomUUID(),
        accesses: [access('file', file, wsA, { count: 2 })],
        mcpCalls: [call(wsA, key, { touched: [{ resourceKind: 'file' as const, resourceId: file, scope: scopeOf(wsA), action: 'read' as const }] })],
        listCounts: [{ workspaceId: wsA, keyId: key, keyName: 'k', day: '2026-11-06', count: 3 }],
      };
      // The commit succeeds but the caller sees a failure: the recorder retries with the same batch id.
      const real = ds.transaction.bind(ds) as (...a: unknown[]) => Promise<unknown>;
      const transaction = vi.spyOn(ds, 'transaction').mockImplementationOnce((async (...args: unknown[]) => {
        await real(...args);
        throw Object.assign(new Error(`connection lost ${SENTINEL}`), { code: '08006' });
      }) as never);
      const first = await persist.persistBatch(batch).catch((e: unknown) => e);
      expect(first).toBeInstanceOf(UsagePersistenceError);
      expect((first as UsagePersistenceError).code).toBe('08006');
      expect(String((first as Error).message) + String((first as Error).stack)).not.toContain(SENTINEL);
      transaction.mockRestore();

      expect(await persist.persistBatch(batch)).toMatchObject({ status: 'duplicate', accessRows: 0, mcpCalls: 0, listRows: 0 });
      expect(await persist.persistBatch(batch)).toMatchObject({ status: 'duplicate' });
      expect(await totals('file_usage_totals', 'file_id', file)).toMatchObject({ total_count: '2' });
      expect((await q('SELECT count::int FROM file_usage_daily WHERE file_id = $1', [file]))[0]!.count).toBe(2);
      expect(await count('mcp_calls')).toBe(1);
      expect(await count('mcp_call_resources')).toBe(1);
      expect((await q('SELECT count::int FROM mcp_list_daily'))[0]!.count).toBe(3);
    });

    it('rolls a failed batch back completely, so a retry applies it exactly once', async () => {
      const file = await addFile(wsA);
      const key = await addKey(wsA, 'k');
      const batch = { batchId: randomUUID(), accesses: [access('file', file, wsA)], mcpCalls: [call(wsA, key)] };
      const real = ds.transaction.bind(ds) as (run: (m: any) => Promise<unknown>) => Promise<unknown>;
      const spy = vi.spyOn(ds, 'transaction').mockImplementationOnce(((run: (m: any) => Promise<unknown>) =>
        real(async (m: any) => {
          const query = m.query.bind(m);
          m.query = async (sql: string, params?: unknown[]) => {
            if (String(sql).includes('INSERT INTO "mcp_calls"')) throw Object.assign(new Error(`boom ${SENTINEL}`), { code: '40001' });
            return query(sql, params);
          };
          return run(m);
        })) as never);
      await expect(persist.persistBatch(batch)).rejects.toMatchObject({ code: '40001' });
      spy.mockRestore();
      expect(await count('usage_batches')).toBe(0);
      expect(await count('file_usage_daily')).toBe(0);
      expect(await persist.persistBatch(batch)).toMatchObject({ status: 'applied', accessRows: 1, mcpCalls: 1 });
      expect(await persist.persistBatch(batch)).toMatchObject({ status: 'duplicate' });
      expect((await totals('file_usage_totals', 'file_id', file))!.total_count).toBe('1');
    });

    it('does not resurrect deleted resources or Workspaces, and rejects a wrong scope', async () => {
      const gone = await addFile(wsA);
      const other = await addFile(wsB);
      const key = await addKey(wsA, 'k');
      await q('DELETE FROM files WHERE id = $1', [gone]);
      const result = await persist.persistBatch({
        batchId: randomUUID(),
        accesses: [
          access('file', gone, wsA), // deleted before the delayed batch arrives
          access('file', other, wsA), // belongs to B, claimed for A
          access('file', other, null), // belongs to B, claimed Global
        ],
      });
      expect(result).toMatchObject({ status: 'applied', accessRows: 0, skippedAccessResources: 3 });
      expect(await count('file_usage_daily')).toBe(0);
      expect(await count('file_usage_totals')).toBe(0);

      await q('DELETE FROM workspaces WHERE id = $1', [wsA]);
      const late = await persist.persistBatch({
        batchId: randomUUID(),
        mcpCalls: [call(wsA, key)],
        listCounts: [{ workspaceId: wsA, keyId: key, keyName: 'k', day: '2026-11-06', count: 1 }],
      });
      expect(late).toMatchObject({ mcpCalls: 0, skippedMcpCalls: 1, listRows: 0, skippedListRows: 1 });
      expect(await count('mcp_calls')).toBe(0);
      expect(await count('mcp_list_daily')).toBe(0);
    });

    it('enforces ownership and scope in the database itself', async () => {
      const file = await addFile(wsA);
      const insert = (scope: string, ws: string | null) =>
        q(`INSERT INTO file_usage_daily (scope, workspace_id, file_id, day, channel, access_kind, count) VALUES ($1, $2, $3, '2026-11-06', 'mcp', 'read', 1)`, [scope, ws, file]);
      await expect(insert('workspace', wsB)).rejects.toMatchObject({ code: '23503' }); // wrong Workspace for the file
      await expect(insert('global', null)).rejects.toMatchObject({ code: '23503' }); // Global claim for a Workspace file
      await expect(insert('global', wsA)).rejects.toMatchObject({ code: '23514' }); // global with a Workspace id
      await expect(insert('workspace', null)).rejects.toMatchObject({ code: '23514' });
      await insert('workspace', wsA);
      await expect(insert('workspace', wsA)).rejects.toMatchObject({ code: '23505' }); // daily uniqueness
      await expect(q(`UPDATE file_usage_daily SET count = 0`)).rejects.toMatchObject({ code: '23514' });
    });

    it('deletes counters with their File or Memory and with their Workspace; Global data is untouched', async () => {
      const f1 = await addFile(wsA);
      const f2 = await addFile(wsA);
      const m1 = await addMemory(wsA);
      const g = await addFile(null);
      const gm = await addMemory(null);
      await persist.persistBatch({
        batchId: randomUUID(),
        accesses: [access('file', f1, wsA), access('file', f2, wsA), access('memory', m1, wsA), access('file', g, null), access('memory', gm, null)],
      });
      await q('DELETE FROM files WHERE id = $1', [f1]);
      expect(await count('file_usage_daily', 'file_id = $1', [f1])).toBe(0);
      expect(await count('file_usage_totals', 'file_id = $1', [f1])).toBe(0);
      expect(await count('file_usage_totals', 'file_id = $1', [f2])).toBe(1);
      await q('DELETE FROM memories WHERE id = $1', [m1]);
      expect(await count('memory_usage_daily', 'memory_id = $1', [m1])).toBe(0);

      await q('DELETE FROM files WHERE workspace_id = $1', [wsA]); // the application deletes a Workspace's data first
      await q('DELETE FROM workspaces WHERE id = $1', [wsA]);
      expect(await count('file_usage_totals', 'workspace_id = $1', [wsA])).toBe(0);
      expect(await count('file_usage_totals')).toBe(1);
      expect(await count('memory_usage_totals')).toBe(1);
    });

    it('rejects an invalid batch before touching the database, without echoing values', async () => {
      const file = await addFile(wsA);
      const bad: Array<() => Promise<unknown>> = [
        () => persist.persistBatch({ batchId: 'nope', accesses: [] }),
        () => persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { count: 0 })] }),
        () => persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { day: '2026-02-30' })] }),
        () => persist.persistBatch({ batchId: randomUUID(), accesses: [access('file', file, wsA, { channel: SENTINEL as never })] }),
        () => persist.persistBatch({ batchId: randomUUID(), mcpCalls: [call(wsA, randomUUID(), { argsSummary: { nested: { query: SENTINEL } } as never })] }),
        () => persist.persistBatch({ batchId: randomUUID(), mcpCalls: [call(wsA, randomUUID(), { argsSummary: { text: 'x'.repeat(201) } })] }),
      ];
      for (const run of bad) {
        const err = await run().catch((e: unknown) => e);
        expect(err).toMatchObject({ code: 'invalid_batch' });
        expect(String((err as Error).message) + String((err as Error).stack)).not.toContain(SENTINEL);
      }
      expect(await count('usage_batches')).toBe(0);
    });
  });

  describe('MCP call history', () => {
    it('stores the safe fields, is idempotent per call id and links touched resources', async () => {
      const key = await addKey(wsA, 'agent key');
      const file = await addFile(wsA);
      const memory = await addMemory(null);
      const c = call(wsA, key, {
        argsSummary: { limit: 5, scope: 'global', types: ['files', 'memories'] },
        touched: [
          { resourceKind: 'file', resourceId: file, scope: scopeOf(wsA), action: 'retrieved' },
          { resourceKind: 'memory', resourceId: memory, scope: scopeOf(null), action: 'retrieved' },
        ],
      });
      expect(await persist.persistBatch({ batchId: randomUUID(), mcpCalls: [c] })).toMatchObject({ mcpCalls: 1 });
      // The same event arriving in a different batch (a re-batched retry) is still a no-op.
      expect(await persist.persistBatch({ batchId: randomUUID(), mcpCalls: [c] })).toMatchObject({ mcpCalls: 0, skippedMcpCalls: 1 });
      const row = (await q('SELECT * FROM mcp_calls WHERE id = $1', [c.id]))[0]!;
      expect(row).toMatchObject({ workspace_id: wsA, key_id: key, key_name: 'agent key', client_name: 'claude', client_version: '1.0', tool: 'get_file', outcome: 'ok', duration_ms: 12, result_chars: 340, truncated: false });
      expect(row.args_summary).toEqual({ limit: 5, scope: 'global', types: ['files', 'memories'] });
      expect(await q('SELECT resource_kind, scope_key, action FROM mcp_call_resources WHERE call_id = $1 ORDER BY resource_kind', [c.id])).toEqual([
        { resource_kind: 'file', scope_key: wsA, action: 'retrieved' },
        { resource_kind: 'memory', scope_key: 'global', action: 'retrieved' },
      ]);
    });

    it('keeps the key id and name snapshot when the key is deleted, and the touched ids when resources are deleted', async () => {
      const key = await addKey(wsA, 'old name');
      const file = await addFile(wsA);
      const c = call(wsA, key, { keyName: 'old name', touched: [{ resourceKind: 'file', resourceId: file, scope: scopeOf(wsA), action: 'read' }] });
      await persist.persistBatch({ batchId: randomUUID(), mcpCalls: [c] });
      await q('UPDATE api_keys SET revoked_at = now() WHERE id = $1', [key]);
      expect((await q('SELECT key_name FROM mcp_calls WHERE id = $1', [c.id]))[0]!.key_name).toBe('old name');
      await q('DELETE FROM api_keys WHERE id = $1', [key]);
      await q('DELETE FROM files WHERE id = $1', [file]);
      expect((await q('SELECT key_id, key_name FROM mcp_calls WHERE id = $1', [c.id]))[0]).toEqual({ key_id: key, key_name: 'old name' });
      expect(await q('SELECT resource_id FROM mcp_call_resources WHERE call_id = $1', [c.id])).toEqual([{ resource_id: file }]);
      // The link table has no name, title or content column, so a deleted resource cannot leave a dangling name.
      const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'mcp_call_resources' ORDER BY column_name`, [iso.schema])).map((r) => r.column_name);
      expect(columns).toEqual(['action', 'call_id', 'resource_id', 'resource_kind', 'scope_key']);
      expect((await q('SELECT count(*)::int c FROM mcp_calls WHERE key_id = $1', [key]))[0]!.c).toBe(1);
    });

    it('deletes calls, touched links and list counters with their Workspace only', async () => {
      const ka = await addKey(wsA, 'a');
      const kb = await addKey(wsB, 'b');
      await persist.persistBatch({
        batchId: randomUUID(),
        mcpCalls: [call(wsA, ka, { touched: [{ resourceKind: 'file', resourceId: randomUUID(), scope: scopeOf(wsA), action: 'read' }] }), call(wsB, kb)],
        listCounts: [{ workspaceId: wsA, keyId: ka, keyName: 'a', day: '2026-11-06', count: 2 }, { workspaceId: wsB, keyId: kb, keyName: 'b', day: '2026-11-06', count: 1 }],
      });
      await q('DELETE FROM workspaces WHERE id = $1', [wsA]);
      expect(await count('mcp_calls')).toBe(1);
      expect(await count('mcp_calls', 'workspace_id = $1', [wsB])).toBe(1);
      expect(await count('mcp_call_resources')).toBe(0);
      expect(await count('mcp_list_daily')).toBe(1);
    });

    it('counts tools/list per key and day and adds up across batches', async () => {
      const key = await addKey(wsA, 'k');
      const list = (day: string, c: number, keyName = 'k') => ({ workspaceId: wsA, keyId: key, keyName, day, count: c });
      await persist.persistBatch({ batchId: randomUUID(), listCounts: [list('2026-11-06', 2), list('2026-11-06', 3), list('2026-11-05', 1)] });
      await persist.persistBatch({ batchId: randomUUID(), listCounts: [list('2026-11-06', 4, 'renamed')] });
      expect(await q('SELECT day::text, key_name, count::int FROM mcp_list_daily ORDER BY day')).toEqual([
        { day: '2026-11-05', key_name: 'k', count: 1 },
        { day: '2026-11-06', key_name: 'renamed', count: 9 },
      ]);
    });

    it('has the indexes the history and window queries need', async () => {
      const idx = (await q(`SELECT indexname FROM pg_indexes WHERE schemaname = $1`, [iso.schema])).map((r) => r.indexname);
      for (const name of [
        'IDX_mcp_calls_workspace_time', 'IDX_mcp_calls_time', 'IDX_mcp_calls_workspace_tool_time', 'IDX_mcp_calls_workspace_key_time',
        'IDX_mcp_calls_workspace_outcome_time', 'IDX_mcp_calls_workspace_client_time', 'IDX_mcp_call_resources_resource',
        'IDX_file_usage_daily_scope_day', 'IDX_memory_usage_daily_scope_day', 'IDX_file_usage_totals_scope_accessed', 'IDX_memory_usage_totals_scope_accessed',
      ]) expect(idx, name).toContain(name);
    });
  });

  describe('retention', () => {
    const NOW = new Date('2026-11-06T12:00:00.000Z');

    it('computes UTC day cutoffs', () => {
      expect(utcCutoff(NOW, 365).toISOString()).toBe('2025-11-06T00:00:00.000Z');
      expect(utcCutoff(NOW, 90).toISOString()).toBe('2026-08-08T00:00:00.000Z');
      expect(utcCutoff(new Date('2026-11-06T23:59:59.999Z'), 1).toISOString()).toBe('2026-11-05T00:00:00.000Z');
    });

    it('prunes strictly beyond the cutoffs, keeps lifetime totals and removes expired ledger records', async () => {
      const file = await addFile(wsA);
      const memory = await addMemory(null);
      const key = await addKey(wsA, 'k');
      await persist.persistBatch({
        batchId: randomUUID(),
        accesses: [
          access('file', file, wsA, { day: '2025-11-05' }), // expired
          access('file', file, wsA, { day: '2025-11-06' }), // exactly at the cutoff day: kept
          access('file', file, wsA, { day: '2026-11-06', count: 2 }),
          access('memory', memory, null, { day: '2025-01-01', accessKind: 'retrieved' }),
        ],
        mcpCalls: [
          call(wsA, key, { occurredAt: new Date('2026-08-07T23:59:59.999Z'), touched: [{ resourceKind: 'file', resourceId: file, scope: scopeOf(wsA), action: 'read' }] }),
          call(wsA, key, { occurredAt: new Date('2026-08-08T00:00:00.000Z') }),
          call(wsA, key, { occurredAt: NOW }),
        ],
        listCounts: [
          { workspaceId: wsA, keyId: key, keyName: 'k', day: '2026-08-07', count: 1 },
          { workspaceId: wsA, keyId: key, keyName: 'k', day: '2026-08-08', count: 1 },
        ],
      });
      const fileBefore = await totals('file_usage_totals', 'file_id', file);
      const memoryBefore = await totals('memory_usage_totals', 'memory_id', memory);
      const oldBatch = randomUUID();
      await q(`INSERT INTO usage_batches (batch_id, applied_at) VALUES ($1, $2)`, [oldBatch, '2026-10-29T11:59:59.000Z']);
      const keptBatch = randomUUID();
      await q(`INSERT INTO usage_batches (batch_id, applied_at) VALUES ($1, $2)`, [keptBatch, '2026-10-30T12:00:01.000Z']);

      const result = await retention.prune(NOW);
      expect(result).toEqual({ usageCutoffDay: '2025-11-06', mcpCutoffDay: '2026-08-08', dailyRows: 2, mcpCalls: 1, listRows: 1, batchRecords: 1 });

      expect((await q('SELECT day::text FROM file_usage_daily ORDER BY day')).map((r) => r.day)).toEqual(['2025-11-06', '2026-11-06']);
      expect(await count('memory_usage_daily')).toBe(0);
      expect(await count('mcp_calls')).toBe(2);
      expect(await count('mcp_call_resources')).toBe(0); // links went with the expired call
      expect((await q('SELECT day::text FROM mcp_list_daily')).map((r) => r.day)).toEqual(['2026-08-08']);
      expect((await q('SELECT batch_id FROM usage_batches ORDER BY batch_id')).map((r) => r.batch_id).sort()).toContain(keptBatch);
      expect((await q('SELECT batch_id FROM usage_batches WHERE batch_id = $1', [oldBatch]))).toEqual([]);
      // Lifetime totals (and their channel and kind breakdowns) are exactly what they were.
      expect(await totals('file_usage_totals', 'file_id', file)).toEqual(fileBefore);
      expect(await totals('memory_usage_totals', 'memory_id', memory)).toEqual(memoryBefore);
      expect(fileBefore).toMatchObject({ total_count: '4', mcp_count: '4' });

      expect(await retention.prune(NOW)).toMatchObject({ dailyRows: 0, mcpCalls: 0, listRows: 0, batchRecords: 0 });
    });

    it('reports a failure as a code only', async () => {
      const broken = new UsageRetentionService({ query: async () => { throw Object.assign(new Error(`relation ${SENTINEL} missing`), { code: '42P01' }); } } as never, { usageRetentionDays: 1, mcpCallRetentionDays: 1 });
      const err = await broken.prune(NOW).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: '42P01' });
      expect(String((err as Error).message)).not.toContain(SENTINEL);
    });
  });
});
