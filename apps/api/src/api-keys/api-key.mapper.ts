import type { ApiKeyDto, ApiKeyStatus } from './api-key.dto.js';
import type { ApiKeyRecord } from './api-key.store.js';

export function apiKeyStatus(r: Pick<ApiKeyRecord, 'revokedAt' | 'expiresAt'>, now: Date = new Date()): ApiKeyStatus {
  if (r.revokedAt) return 'revoked';
  if (r.expiresAt && r.expiresAt.getTime() <= now.getTime()) return 'expired';
  return 'active';
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

/** Field-by-field copy so nothing internal can leak by being added to the record later. */
export function toApiKeyDto(r: ApiKeyRecord, now: Date = new Date()): ApiKeyDto {
  return {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    permissions: [...r.permissions],
    createdAt: new Date(r.createdAt).toISOString(),
    lastUsedAt: iso(r.lastUsedAt),
    expiresAt: iso(r.expiresAt),
    revokedAt: iso(r.revokedAt),
    status: apiKeyStatus(r, now),
  };
}
