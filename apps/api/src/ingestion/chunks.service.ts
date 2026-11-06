import { Inject, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { getDataSourceToken } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { UsageCollector } from '../usage/usage-request-context.js';
import { AuthorizationService } from '../auth/authorization.service.js';
import type { Principal } from '../auth/principal.js';
import { type ScopeRef, isUuid } from '../scopes/scope-ref.js';
import { scopeKeyOf } from '../tags/tags.service.js';
import { type ChunkPage, type ChunkRow, toChunkDto } from './chunk.dto.js';
import { parseChunkListQuery } from './chunk-list-query.js';

/**
 * `file.chunks` (`files:read`): ordered, keyset-paginated chunk previews of one file. Authorization comes first, the
 * file is looked up inside the explicit scope (a foreign, ungranted or missing file is the same 404), and the chunk
 * query is bound to both the file id and the scope key. Embeddings are never selected.
 */
@Injectable()
export class ChunksService {
  constructor(
    @Inject(getDataSourceToken()) private readonly dataSource: DataSource,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Optional() @Inject(UsageCollector) private readonly usage?: UsageCollector,
  ) {}

  async list(principal: Principal, scope: ScopeRef, fileId: string, rawQuery: unknown): Promise<ChunkPage> {
    this.authorization.assertCan(principal, 'file.chunks', scope);
    const q = parseChunkListQuery(rawQuery);
    if (!isUuid(fileId)) throw new NotFoundException('Not Found');
    const id = fileId.toLowerCase();
    const scopeKey = scopeKeyOf(scope);
    const exists = (await this.dataSource.query(`SELECT 1 FROM "files" WHERE "id" = $1 AND "scope_key" = $2`, [id, scopeKey])) as unknown[];
    if (exists.length === 0) throw new NotFoundException('Not Found');

    const rows = (await this.dataSource.query(
      `SELECT "id", "file_id", "ordinal", "content", "char_count", "location" FROM "chunks"
       WHERE "file_id" = $1 AND "scope_key" = $2 AND "ordinal" > $3
       ORDER BY "ordinal" ASC LIMIT $4`,
      [id, scopeKey, q.afterOrdinal ?? -1, q.limit + 1],
    )) as ChunkRow[];
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    this.usage?.stage({ resourceKind: 'file', resourceId: id, scope, accessKind: 'read' });
    return { items: page.map(toChunkDto), nextCursor: hasMore && last ? String(last.ordinal) : null, hasMore, limit: q.limit };
  }
}
