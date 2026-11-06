import type { ScopeRef } from '../scopes/scope-ref.js';
import type { UsageResourceKind } from './usage.constants.js';
import type { UsageCollector } from './usage-request-context.js';

/** A resource that appeared in a returned result: ids, kind and scope only, never content. */
export interface RetrievedRef {
  resourceKind: UsageResourceKind;
  resourceId: string;
  scope: ScopeRef;
}

/** The structural part of a search result or context source that identifies what it came from. */
interface ResultLike {
  kind: string;
  id: string;
  scope: { kind: 'global' } | { kind: 'workspace'; id: string };
  file?: { id: string };
}

/**
 * The distinct Files and Memories behind returned results. A chunk counts for its File (once however many chunks of
 * it are returned), a Memory for itself; the scope is the result's own scope, so Global results are attributed to
 * Global even when a Workspace asked.
 */
export function retrievedRefsOf(results: readonly ResultLike[]): RetrievedRef[] {
  const seen = new Map<string, RetrievedRef>();
  for (const r of results) {
    const resourceKind: UsageResourceKind | null = r.kind === 'chunk' ? 'file' : r.kind === 'memory' ? 'memory' : null;
    const resourceId = r.kind === 'chunk' ? r.file?.id : r.id;
    if (!resourceKind || typeof resourceId !== 'string') continue;
    const scope: ScopeRef = r.scope.kind === 'global' ? { kind: 'global' } : { kind: 'workspace', workspaceId: r.scope.id };
    seen.set(`${resourceKind}|${resourceId}`, { resourceKind, resourceId, scope });
  }
  return [...seen.values()];
}

/** Stages `retrieved` accesses for results that are about to be returned. Never throws. */
export function stageRetrieved(usage: UsageCollector | undefined, results: readonly ResultLike[]): void {
  try {
    if (!usage) return;
    for (const ref of retrievedRefsOf(results)) usage.stage({ ...ref, accessKind: 'retrieved' });
  } catch {
    /* best effort: recording never changes a response */
  }
}
