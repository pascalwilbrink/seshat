import { type CanActivate, type ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service.js';
import type { HttpRequest } from './http.js';
import { ADMIN_PRINCIPAL } from './principal.js';
import { SESSION_COOKIE_NAME, readCookie } from './session-token.js';

/** The only routes reachable without a session: exact method + path pairs. Everything else is denied by default. */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/health' }),
  Object.freeze({ method: 'POST', path: '/api/auth/login' }),
]);

export function isPublicRoute(method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PUBLIC_ROUTES.some((r) => r.method === method.toUpperCase() && r.path === normalized);
}

/** Global default-deny guard: a valid signed, unexpired session cookie is required unless the route is allow-listed. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') throw new UnauthorizedException('Unauthorized');
    const req = context.switchToHttp().getRequest<HttpRequest>();
    if (isPublicRoute(req.method, req.path)) return true;
    const cookie = readCookie(req.headers.cookie as string | undefined, SESSION_COOKIE_NAME);
    if (!cookie || !this.auth.isValidSessionToken(cookie)) throw new UnauthorizedException('Unauthorized');
    req.principal = ADMIN_PRINCIPAL;
    return true;
  }
}
