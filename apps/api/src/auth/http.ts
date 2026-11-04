import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Principal } from './principal.js';

/** Minimal structural view of the Express objects used by auth, so no express types are required. */
export interface HttpRequest {
  method: string;
  path: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  principal?: Principal;
}

export interface CookieOptions {
  httpOnly: boolean;
  sameSite: 'lax';
  secure: boolean;
  path: string;
  maxAge?: number;
}

export interface HttpResponse {
  cookie(name: string, value: string, options: CookieOptions): unknown;
  clearCookie(name: string, options: CookieOptions): unknown;
  setHeader(name: string, value: string): unknown;
}

/** The principal resolved by SessionGuard. Only available on protected routes. */
export const CurrentPrincipal = createParamDecorator((_data: unknown, ctx: ExecutionContext): Principal => {
  const principal = ctx.switchToHttp().getRequest<HttpRequest>().principal;
  if (!principal) throw new Error('No principal on a protected route');
  return principal;
});
