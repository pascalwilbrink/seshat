import type { Permission } from '@seshat/domain';

/**
 * Who is making a request. A discriminated union on `kind`.
 * Add new principal kinds here and handle them in AuthorizationService.
 */
export type AdminPrincipal = { kind: 'admin' };

/** A Workspace API key. `permissions` come from the shared catalog; the guard resolves them on every request. */
export type ApiKeyPrincipal = {
  kind: 'apiKey';
  keyId: string;
  workspaceId: string;
  permissions: readonly Permission[];
};

export type Principal = AdminPrincipal | ApiKeyPrincipal;

export const ADMIN_PRINCIPAL: Principal = Object.freeze({ kind: 'admin' }) as Principal;
