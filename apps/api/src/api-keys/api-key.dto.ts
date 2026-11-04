import { PERMISSIONS, type Permission } from '@seshat/domain';
import { z } from 'zod';

export const MAX_API_KEY_NAME_LENGTH = 100;

const name = z
  .string({ error: 'Name must be a string' })
  .trim()
  .min(1, 'Name must not be empty')
  .max(MAX_API_KEY_NAME_LENGTH, `Name must be at most ${MAX_API_KEY_NAME_LENGTH} characters`);

/** A non-empty list of known permissions from the shared catalog; duplicates collapse. */
const permissions = z
  .array(z.enum(PERMISSIONS as unknown as [Permission, ...Permission[]], { error: 'Unknown permission' }), {
    error: 'Permissions must be a list',
  })
  .min(1, 'Select at least one permission')
  .max(PERMISSIONS.length, 'Too many permissions')
  .transform((list) => [...new Set(list)]);

const expiresAt = z
  .string({ error: 'Expiry must be a date string' })
  .max(64, 'Expiry is too long')
  .pipe(z.iso.datetime({ offset: true, error: 'Expiry must be an ISO 8601 date-time' }))
  .refine((v) => new Date(v).getTime() > Date.now(), { error: 'Expiry must be in the future' })
  .nullable();

export const createApiKeySchema = z.strictObject({ name, permissions, expiresAt: expiresAt.optional() });
export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

/** Only name and permissions are editable: not expiry, Workspace, prefix, digest or revocation state. */
export const updateApiKeySchema = z
  .strictObject({ name: name.optional(), permissions: permissions.optional() })
  .refine((v) => v.name !== undefined || v.permissions !== undefined, { error: 'Provide name and/or permissions' });
export type UpdateApiKeyInput = z.infer<typeof updateApiKeySchema>;

export type ApiKeyStatus = 'active' | 'revoked' | 'expired';

/** Safe key metadata. An explicit allowlist: no digest, no secret, no Workspace id. */
export interface ApiKeyDto {
  id: string;
  name: string;
  prefix: string;
  permissions: Permission[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  status: ApiKeyStatus;
}

/** The only response that carries the full key, returned once by creation. */
export interface CreatedApiKeyDto {
  apiKey: ApiKeyDto;
  secret: string;
}
