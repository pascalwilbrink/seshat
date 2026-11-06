import { Inject, Injectable, Logger, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { ScopeRef } from '../scopes/scope-ref.js';
import type { AccessKind, UsageChannel, UsageResourceKind } from './usage.constants.js';
import type {
  ListCountIncrement,
  McpCallRecord,
  ResourceAccessIncrement,
  UsageBatchInput,
  UsageBatchResult,
} from './usage-batch.js';
import {
  MAX_BATCH_ACCESSES,
  MAX_BATCH_CALLS,
  MAX_BATCH_LIST_COUNTS,
  MAX_BATCH_TOUCHED,
  UsagePersistenceService,
} from './usage-persistence.service.js';

export const USAGE_FLUSH_INTERVAL_MS = 5000;
/** Upper bounds of the in-memory buffer; beyond them new items are dropped (and counted), never queued unboundedly. */
export const USAGE_BUFFER_LIMITS = { accesses: 10_000, calls: 5_000, listCounts: 2_000 } as const;

export interface UsageAccessInput {
  resourceKind: UsageResourceKind;
  resourceId: string;
  scope: ScopeRef;
  channel: UsageChannel;
  accessKind: AccessKind;
  /** Defaults to now. */
  at?: Date;
}

export type McpCallInput = Omit<McpCallRecord, 'id' | 'occurredAt'> & { id?: string; occurredAt?: Date };

export interface ListCountInput {
  workspaceId: string;
  keyId: string;
  keyName: string;
  at?: Date;
}

/** Only what flushing needs from storage; makes the recorder testable without a database. */
export interface UsageBatchSink {
  persistBatch(input: UsageBatchInput): Promise<UsageBatchResult>;
}

/**
 * Best-effort, in-memory buffered usage recording.
 *
 * Semantics (callers may rely on exactly this, and on nothing more):
 * - `enqueue*` are synchronous, never throw, never touch the database and never await anything. Whatever goes wrong
 *   inside (bad input, a full buffer) is swallowed and at most counted, so recording cannot change a response.
 * - Access increments are aggregated in memory per (resource, UTC day, channel, kind). A timer (about every 5 s) and
 *   graceful shutdown (`beforeApplicationShutdown`, which runs before TypeORM closes) flush the buffer in batches.
 * - A flush swaps the buffer out first, so enqueues during a flush land in the new buffer. Flushes never overlap.
 * - Each batch has a stable id. A failed batch is retried once with the same id (so an uncertain commit cannot count
 *   twice, the storage deduplicates by batch id); after the second failure it is dropped and only counts are logged.
 * - Recording is therefore eventually consistent and lossy: a process crash, a full buffer or two failed attempts
 *   lose the affected increments. Counts are insights, not accounting.
 * - Nothing here ever logs or keeps queries, content, titles, metadata or error messages, only counts.
 */
@Injectable()
export class UsageRecorderService implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger('UsageRecorder');
  private accesses = new Map<string, ResourceAccessIncrement>();
  private calls: McpCallRecord[] = [];
  private listCounts = new Map<string, ListCountIncrement>();
  private droppedOverflow = 0;
  private chain: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private stopped = false;

  constructor(@Inject(UsagePersistenceService) private readonly sink: UsageBatchSink) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush(), USAGE_FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  enqueueAccess(input: UsageAccessInput): void {
    try {
      if (this.stopped) return;
      const at = input.at ?? new Date();
      const day = at.toISOString().slice(0, 10);
      const scopeKey = input.scope.kind === 'global' ? 'global' : input.scope.workspaceId;
      const key = [input.resourceKind, input.resourceId, scopeKey, day, input.channel, input.accessKind].join('|');
      const existing = this.accesses.get(key);
      if (existing) {
        existing.count += 1;
        if (at > existing.lastAccessedAt) existing.lastAccessedAt = at;
        return;
      }
      if (this.accesses.size >= USAGE_BUFFER_LIMITS.accesses) return void this.droppedOverflow++;
      this.accesses.set(key, {
        resourceKind: input.resourceKind,
        resourceId: input.resourceId,
        scope: input.scope,
        day,
        channel: input.channel,
        accessKind: input.accessKind,
        count: 1,
        lastAccessedAt: at,
      });
    } catch {
      /* best effort */
    }
  }

  enqueueMcpCall(input: McpCallInput): void {
    try {
      if (this.stopped) return;
      if (this.calls.length >= USAGE_BUFFER_LIMITS.calls) return void this.droppedOverflow++;
      this.calls.push({ ...input, id: input.id ?? randomUUID(), occurredAt: input.occurredAt ?? new Date() });
    } catch {
      /* best effort */
    }
  }

  /** `tools/list` counter, per key per UTC day. */
  enqueueListCount(input: ListCountInput): void {
    try {
      if (this.stopped) return;
      const day = (input.at ?? new Date()).toISOString().slice(0, 10);
      const key = `${input.keyId}|${day}`;
      const existing = this.listCounts.get(key);
      if (existing) {
        existing.count += 1;
        return;
      }
      if (this.listCounts.size >= USAGE_BUFFER_LIMITS.listCounts) return void this.droppedOverflow++;
      this.listCounts.set(key, { workspaceId: input.workspaceId, keyId: input.keyId, keyName: input.keyName, day, count: 1 });
    } catch {
      /* best effort */
    }
  }

  /** Writes the buffered items now. Never rejects; concurrent calls run one after the other. */
  flush(): Promise<void> {
    this.chain = this.chain.then(() => this.flushOnce()).catch(() => undefined);
    return this.chain;
  }

  private async flushOnce(): Promise<void> {
    const accesses = [...this.accesses.values()];
    const calls = this.calls;
    const listCounts = [...this.listCounts.values()];
    const overflow = this.droppedOverflow;
    this.accesses = new Map();
    this.calls = [];
    this.listCounts = new Map();
    this.droppedOverflow = 0;
    if (overflow > 0) this.logger.warn(`Usage buffer overflow: dropped ${overflow} items`);

    for (const batch of this.toBatches(accesses, calls, listCounts)) {
      const items = (batch.accesses?.length ?? 0) + (batch.mcpCalls?.length ?? 0) + (batch.listCounts?.length ?? 0);
      let ok = false;
      for (let attempt = 1; attempt <= 2 && !ok; attempt++) {
        try {
          await this.sink.persistBatch(batch); // same batchId on the retry
          ok = true;
        } catch {
          /* retried once, then dropped below */
        }
      }
      if (!ok) this.logger.warn(`Usage batch dropped after retry: ${items} items`);
    }
  }

  private toBatches(accesses: ResourceAccessIncrement[], calls: McpCallRecord[], listCounts: ListCountIncrement[]): UsageBatchInput[] {
    const batches: UsageBatchInput[] = [];
    for (let i = 0; i < accesses.length; i += MAX_BATCH_ACCESSES) {
      batches.push({ batchId: randomUUID(), accesses: accesses.slice(i, i + MAX_BATCH_ACCESSES) });
    }
    let current: McpCallRecord[] = [];
    let touched = 0;
    for (const call of calls) {
      if (current.length >= MAX_BATCH_CALLS || touched + call.touched.length > MAX_BATCH_TOUCHED) {
        batches.push({ batchId: randomUUID(), mcpCalls: current });
        current = [];
        touched = 0;
      }
      current.push(call);
      touched += call.touched.length;
    }
    if (current.length > 0) batches.push({ batchId: randomUUID(), mcpCalls: current });
    for (let i = 0; i < listCounts.length; i += MAX_BATCH_LIST_COUNTS) {
      batches.push({ batchId: randomUUID(), listCounts: listCounts.slice(i, i + MAX_BATCH_LIST_COUNTS) });
    }
    return batches;
  }
}
