import type { UsageOverviewDto } from '@/lib/api-types';

/** An aggregate with zero data and 30 daily points, as the API zero-fills it. */
export function emptyUsage(scope: 'global' | 'workspace', days: 7 | 30 | 90 = 30): UsageOverviewDto {
  const day = (i: number) => new Date(Date.UTC(2026, 10, 6) - (days - 1 - i) * 86_400_000).toISOString().slice(0, 10);
  const range = Array.from({ length: days }, (_, i) => day(i));
  return {
    scope,
    workspaceId: scope === 'global' ? null : 'uuid-1',
    window: { days, from: range[0]!, to: range[days - 1]! },
    files: { total: 0, indexed: 0, failed: 0 },
    memories: { total: 0, active: 0, superseded: 0 },
    mcp: { calls: 0, errors: 0, errorRate: 0 },
    unused: { files: 0, memories: 0 },
    accessesDaily: range.map((d) => ({ day: d, total: 0, byChannel: { ui: 0, api: 0, mcp: 0 } })),
    callsDaily: range.map((d) => ({ day: d, total: 0, byOutcome: { ok: 0, validation_error: 0, forbidden: 0, not_found: 0, unknown_tool: 0, internal_error: 0 } })),
    topTools: [],
    topFiles: [],
    topMemories: [],
    callsByWorkspace: scope === 'global' ? [] : null,
  };
}

const FILE_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const MEM_A = '22222222-bbbb-4bbb-8bbb-222222222222';
export { FILE_A, MEM_A };

/** Populated aggregate: 2 days, known numbers for exact assertions. */
export function sampleUsage(scope: 'global' | 'workspace', days: 7 | 30 | 90 = 30): UsageOverviewDto {
  const base = emptyUsage(scope, days);
  const n = base.accessesDaily.length;
  base.accessesDaily[n - 2] = { day: base.accessesDaily[n - 2]!.day, total: 5, byChannel: { ui: 2, api: 1, mcp: 2 } };
  base.accessesDaily[n - 1] = { day: base.accessesDaily[n - 1]!.day, total: 3, byChannel: { ui: 0, api: 3, mcp: 0 } };
  base.callsDaily[n - 1] = { day: base.callsDaily[n - 1]!.day, total: 10, byOutcome: { ok: 8, validation_error: 1, forbidden: 0, not_found: 0, unknown_tool: 0, internal_error: 1 } };
  return {
    ...base,
    files: { total: 12, indexed: 10, failed: 2 },
    memories: { total: 7, active: 5, superseded: 2 },
    mcp: { calls: 10, errors: 2, errorRate: 0.2 },
    unused: { files: 4, memories: 3 },
    topTools: [
      { tool: 'recall', calls: 6 },
      { tool: 'remember', calls: 4 },
    ],
    topFiles: [{ id: FILE_A, count: 5 }],
    topMemories: [{ id: MEM_A, count: 3 }],
    callsByWorkspace: scope === 'global' ? [{ workspaceId: 'uuid-1', slug: 'alpha', name: 'Alpha', calls: 10 }] : null,
  };
}
