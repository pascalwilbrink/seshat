import { AsyncLocalStorage } from 'node:async_hooks';
import { Inject, Injectable } from '@nestjs/common';
import type { ScopeRef } from '../scopes/scope-ref.js';
import type { AccessKind, McpTouchAction, UsageChannel, UsageResourceKind } from './usage.constants.js';
import { UsageRecorderService } from './usage-recorder.service.js';

export interface StagedAccess {
  resourceKind: UsageResourceKind;
  resourceId: string;
  scope: ScopeRef;
  accessKind: AccessKind;
}

export interface TouchedId {
  resourceKind: UsageResourceKind;
  resourceId: string;
  scope: ScopeRef;
  action: McpTouchAction;
}

/**
 * Request-local staging of accesses. Holds ids, scopes and kinds only, never content. The channel is explicit
 * (`ui` admin UI, `api` REST key, `mcp` MCP key). Nothing reaches the recorder until `commit()`.
 */
export class UsageRequestContext {
  private readonly staged = new Map<string, StagedAccess>();
  private readonly touchedIds = new Map<string, TouchedId>();
  private done = false;

  constructor(readonly channel: UsageChannel) {}

  /** One entry per (resource kind, id, access kind) per request, however often it is staged. */
  stage(access: StagedAccess): void {
    if (this.done) return;
    this.staged.set(`${access.resourceKind}|${access.resourceId}|${access.accessKind}`, access);
  }

  /** Touched resources of an MCP call (also writes); metadata only, never counted as accesses. */
  touch(touched: TouchedId): void {
    if (this.done) return;
    this.touchedIds.set(`${touched.resourceKind}|${touched.resourceId}|${touched.action}`, touched);
  }

  stagedAccesses(): StagedAccess[] {
    return [...this.staged.values()];
  }

  touched(): TouchedId[] {
    return [...this.touchedIds.values()];
  }

  /** Hands the staged accesses over and closes the context. Call only after a successful caller-visible result. */
  takeForCommit(): StagedAccess[] {
    if (this.done) return [];
    this.done = true;
    return this.stagedAccesses();
  }

  /** Failed, denied or aborted request: nothing is recorded. */
  discard(): void {
    this.done = true;
    this.staged.clear();
  }
}

/**
 * Ambient request context. Services call `stage`/`touch` without knowing whether a request is active: with no context
 * (ingestion, embedding, cleanup, nested system reads) they are no-ops, so system reads never count.
 */
@Injectable()
export class UsageCollector {
  private readonly als = new AsyncLocalStorage<UsageRequestContext>();

  constructor(@Inject(UsageRecorderService) private readonly recorder: UsageRecorderService) {}

  /** Runs `fn` with a fresh context for `channel`. Simultaneous requests are isolated from each other. */
  run<T>(channel: UsageChannel, fn: (ctx: UsageRequestContext) => T): T {
    return this.als.run(new UsageRequestContext(channel), () => fn(this.als.getStore()!));
  }

  current(): UsageRequestContext | undefined {
    return this.als.getStore();
  }

  stage(access: StagedAccess): void {
    try {
      this.als.getStore()?.stage(access);
    } catch {
      /* best effort */
    }
  }

  touch(touched: TouchedId): void {
    try {
      this.als.getStore()?.touch(touched);
    } catch {
      /* best effort */
    }
  }

  /** Enqueues the staged accesses (synchronously, no I/O). Never throws. */
  commit(ctx: UsageRequestContext | undefined = this.als.getStore()): void {
    try {
      if (!ctx) return;
      const at = new Date();
      for (const a of ctx.takeForCommit()) {
        this.recorder.enqueueAccess({ ...a, channel: ctx.channel, at });
      }
    } catch {
      /* best effort */
    }
  }

  discard(ctx: UsageRequestContext | undefined = this.als.getStore()): void {
    try {
      ctx?.discard();
    } catch {
      /* best effort */
    }
  }
}
