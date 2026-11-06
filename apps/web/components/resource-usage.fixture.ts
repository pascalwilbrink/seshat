import type { ResourceUsageDto } from '@/lib/api-types';

/** A usage response with `total` accesses spread over 30 zero-filled days (all on the last day). */
export function usageFixture(over: Partial<ResourceUsageDto> = {}, total = 0): ResourceUsageDto {
  const daily = Array.from({ length: 30 }, (_, i) => {
    const hit = i === 29 ? total : 0;
    return { day: `2026-10-${String(i + 8).padStart(2, '0')}`, total: hit, byChannel: { ui: hit, api: 0, mcp: 0 }, byKind: { read: hit, retrieved: 0 } };
  });
  return {
    resource: 'file',
    id: 'f1',
    scope: 'global',
    workspaceId: null,
    window: { days: 30, from: '2026-10-08', to: '2026-11-06' },
    lifetime: { total, byChannel: { ui: total, api: 0, mcp: 0 }, byKind: { read: total, retrieved: 0 } },
    lastAccessedAt: total > 0 ? '2026-11-06T09:00:00.000Z' : null,
    daily,
    ...over,
  };
}
