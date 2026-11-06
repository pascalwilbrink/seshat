import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { describe, expect, it } from 'vitest';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { ApiKeyPrincipal, Principal } from '../auth/principal.js';
import { FilesService } from './files.service.js';
import { FILE_UPLOADED_EVENT } from './file.events.js';

const WS = randomUUID();
const scope = { kind: 'workspace', workspaceId: WS } as const;
const KEY_ID = randomUUID();
const key = (permissions: ApiKeyPrincipal['permissions']): ApiKeyPrincipal => ({ kind: 'apiKey', keyId: KEY_ID, keyName: 'ci key', workspaceId: WS, permissions });

function row(id: string, params: unknown[]) {
  return {
    id, scope: 'workspace', workspace_id: WS, name: params[3], extension: params[4], mime_type: params[5], size_bytes: params[6], sha256: params[7],
    collection_id: params[9], ingestion_status: 'pending', ingestion_error: null, indexed_at: null, chunk_count: 0,
    created_by_kind: params[10], created_by_key_id: params[11], created_by_key_name: params[12], client_name: params[13], client_version: params[14],
    created_at: new Date(), updated_at: new Date(),
  };
}

function setup(opts: { collectionFails?: boolean } = {}) {
  const stored = new Map<string, Buffer>();
  const deleted: string[] = [];
  const inserts: unknown[][] = [];
  const emitted: unknown[] = [];
  const order: string[] = [];
  let inserted: ReturnType<typeof row> | undefined;
  const storage = {
    async put(k: string, stream: Readable) {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      stored.set(k, Buffer.concat(chunks));
      return { size: stored.get(k)!.length };
    },
    async delete(k: string) {
      stored.delete(k);
      deleted.push(k);
    },
  };
  const manager = {
    async query(sql: string, params: unknown[]) {
      if (sql.includes('INSERT INTO "files"')) {
        inserts.push(params);
        inserted = row(params[0] as string, params);
        order.push('insert');
        return [];
      }
      if (sql.includes('FROM "files"')) return [inserted];
      return [];
    },
  };
  const dataSource = {
    async transaction(cb: (m: typeof manager) => unknown) {
      const result = await cb(manager);
      order.push('commit');
      return result;
    },
    async query() {
      return [{}]; // the Workspace exists
    },
  };
  const events = new EventEmitter2();
  events.on(FILE_UPLOADED_EVENT, (e) => {
    order.push('event');
    emitted.push(e);
  });
  const service = new FilesService(
    dataSource as never,
    new AuthorizationService(),
    storage as never,
    {
      async resolveMembership(_m: unknown, _s: unknown, id: string | null) {
        if (opts.collectionFails) throw new BadRequestException('Invalid request');
        return id;
      },
    } as never,
    { async replaceFileTags(_m: unknown, _s: unknown, _id: string, names: string[]) { return [...names].sort(); } } as never,
    { async record() {}, drain() {} } as never,
    events,
    { maxUploadBytes: 1000 },
  );
  return { service, stored, deleted, inserts, emitted, order };
}

describe('FilesService.uploadBuffer (shared upload core)', () => {
  it('stores under the generated layout, records key and client provenance, and emits file.uploaded after the commit', async () => {
    const t = setup();
    const dto = await t.service.uploadBuffer(
      key(['files:write']), scope,
      { name: '../notes.MD', mimeType: 'text/plain', content: Buffer.from('# hello'), tags: ['b', 'a'] },
      { name: 'claude-code', version: '2.0' }, 100,
    );
    expect(dto).toMatchObject({ name: 'notes.MD', extension: 'md', sizeBytes: 7, ingestionStatus: 'pending', tags: ['a', 'b'] });
    expect(dto.provenance).toEqual({
      createdBy: { kind: 'api_key', keyId: KEY_ID, keyName: 'ci key' },
      client: { name: 'claude-code', version: '2.0' },
    });
    expect([...t.stored.keys()]).toEqual([`originals/workspaces/${WS}/${dto.id}`]);
    expect(t.emitted).toEqual([{ id: dto.id, scope }]);
    expect(t.order).toEqual(['insert', 'commit', 'event']);
  });

  it('records admin provenance without a client for a non-MCP caller', async () => {
    const t = setup();
    const dto = await t.service.uploadBuffer({ kind: 'admin' } as Principal, scope, { name: 'a.txt', mimeType: 'text/plain', content: Buffer.from('x') }, null, 100);
    expect(dto.provenance).toEqual({ createdBy: { kind: 'admin', keyId: null, keyName: null }, client: null });
  });

  it('stores nothing above the cap and emits nothing', async () => {
    const t = setup();
    await expect(
      t.service.uploadBuffer(key(['files:write']), scope, { name: 'a.txt', mimeType: 'text/plain', content: Buffer.alloc(101) }, null, 100),
    ).rejects.toBeInstanceOf(PayloadTooLargeException);
    expect(t.stored.size).toBe(0);
    expect(t.inserts).toHaveLength(0);
    expect(t.emitted).toHaveLength(0);
  });

  it('removes the stored object and emits nothing when the Collection check fails (same 400 as REST)', async () => {
    const t = setup({ collectionFails: true });
    await expect(
      t.service.uploadBuffer(key(['files:write']), scope, { name: 'a.txt', mimeType: 'text/plain', content: Buffer.from('x'), collectionId: randomUUID() }, null, 100),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(t.stored.size).toBe(0);
    expect(t.deleted).toHaveLength(1);
    expect(t.emitted).toHaveLength(0);
  });

  it('refuses a key without files:write before storing anything', async () => {
    const t = setup();
    await expect(
      t.service.uploadBuffer(key(['files:read']), scope, { name: 'a.txt', mimeType: 'text/plain', content: Buffer.from('x') }, null, 100),
    ).rejects.toThrow();
    expect(t.stored.size).toBe(0);
  });

  it('the multipart route goes through the same core: same layout, event and provenance without a client', async () => {
    const t = setup();
    const boundary = 'xBOUNDARYx';
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="tags"\r\n\r\nt1\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="n.md"\r\nContent-Type: text/markdown\r\n\r\n# hi\r\n--${boundary}--\r\n`,
    );
    const req = Object.assign(Readable.from([body]), { headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, complete: true });
    const dto = await t.service.upload(key(['files:write']), scope, req as never);
    expect(dto).toMatchObject({ name: 'n.md', sizeBytes: 4, tags: ['t1'] });
    expect(dto.provenance).toEqual({ createdBy: { kind: 'api_key', keyId: KEY_ID, keyName: 'ci key' }, client: null });
    expect([...t.stored.keys()]).toEqual([`originals/workspaces/${WS}/${dto.id}`]);
    expect(t.order).toEqual(['insert', 'commit', 'event']);
  });
});
