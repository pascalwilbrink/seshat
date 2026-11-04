/**
 * Who is making a request. A discriminated union on `kind`; only the admin variant exists.
 * Future principal kinds (e.g. API keys) are added here and handled in AuthorizationService.
 */
export type AdminPrincipal = { kind: 'admin' };
export type Principal = AdminPrincipal;

export const ADMIN_PRINCIPAL: Principal = Object.freeze({ kind: 'admin' }) as Principal;
