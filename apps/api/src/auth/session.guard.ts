import {
  BadRequestException,
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeyStore } from '../api-keys/api-key.store.js';
import { AuthService } from './auth.service.js';
import type { HttpRequest } from './http.js';
import { CLOCK, type Clock } from './login-rate-limiter.js';
import { ADMIN_PRINCIPAL, type ApiKeyPrincipal } from './principal.js';
import { SESSION_COOKIE_NAME, readCookie } from './session-token.js';

const MAX_AUTHORIZATION_HEADER_LENGTH = 256;
const MAX_COOKIE_HEADER_LENGTH = 4096;
const BEARER_RE = /^Bearer[ \t]+(\S+)$/i;

/** True when the Authorization header uses the Bearer scheme, whatever follows (it is never echoed). */
function hasBearerScheme(header: unknown): boolean {
  return typeof header === 'string' && /^Bearer(?:[ \t]|$)/i.test(header);
}

/** True when a cookie named like the session cookie is present at all, valid or not, single or duplicated. */
function hasSessionCookie(header: unknown): boolean {
  if (typeof header !== 'string') return false;
  // An oversized header is not parsed; treat any mention of the name as present.
  if (header.length > MAX_COOKIE_HEADER_LENGTH) return header.includes(SESSION_COOKIE_NAME);
  return header.split(';').some((part) => {
    const eq = part.indexOf('=');
    return (eq === -1 ? part : part.slice(0, eq)).trim() === SESSION_COOKIE_NAME;
  });
}

/** The only routes reachable without a session: exact method + path pairs. Everything else is denied by default. */
export const PUBLIC_ROUTES: ReadonlyArray<{ method: string; path: string }> = Object.freeze([
  Object.freeze({ method: 'GET', path: '/api/health' }),
  Object.freeze({ method: 'POST', path: '/api/auth/login' }),
]);

export function isPublicRoute(method: string, path: string): boolean {
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PUBLIC_ROUTES.some((r) => r.method === method.toUpperCase() && r.path === normalized);
}

/**
 * Global default-deny guard. Authenticates either an admin session cookie or `Authorization: Bearer <API key>`.
 * It only authenticates (who is calling); what the principal may do is decided by AuthorizationService.
 *
 * A request carrying both credentials is rejected with 400 before anything else, also on public routes and
 * also when the cookie is invalid, so no credential is ever silently preferred. Every bearer failure
 * (malformed, unknown, wrong, revoked, expired) is the same generic 401.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ApiKeyStore) private readonly keys: ApiKeyStore,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') throw new UnauthorizedException('Unauthorized');
    const req = context.switchToHttp().getRequest<HttpRequest>();

    const authorization = req.headers.authorization;
    const bearer = hasBearerScheme(authorization);
    if (bearer && hasSessionCookie(req.headers.cookie)) throw new BadRequestException('Ambiguous credentials');

    if (isPublicRoute(req.method, req.path)) return true;

    if (bearer) {
      req.principal = await this.authenticateKey(authorization as string);
      return true;
    }

    const cookie = readCookie(req.headers.cookie as string | undefined, SESSION_COOKIE_NAME);
    if (!cookie || !this.auth.isValidSessionToken(cookie)) throw new UnauthorizedException('Unauthorized');
    req.principal = ADMIN_PRINCIPAL;
    return true;
  }

  private async authenticateKey(header: string): Promise<ApiKeyPrincipal> {
    const token = header.length <= MAX_AUTHORIZATION_HEADER_LENGTH ? BEARER_RE.exec(header)?.[1] : undefined;
    // Current status and permissions are read on every request: edits and revocation apply immediately.
    const record = token ? await this.keys.findByKey(token) : null;
    if (
      !record ||
      record.revokedAt !== null ||
      (record.expiresAt !== null && record.expiresAt.getTime() <= this.clock.now()) ||
      record.permissions.length === 0
    ) {
      throw new UnauthorizedException('Unauthorized');
    }
    try {
      await this.keys.touchLastUsed(record.id);
    } catch {
      // Best effort: a failed last-used write must not fail an authenticated request.
    }
    return { kind: 'apiKey', keyId: record.id, workspaceId: record.workspaceId, permissions: record.permissions };
  }
}
