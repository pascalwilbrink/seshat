import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { globalScope } from '../scopes/scope-ref.js';
import { AuthService } from './auth.service.js';
import { AuthorizationService } from './authorization.service.js';
import { IdentityService, type AdminSessionDto, type SessionDto } from './identity.service.js';
import { type CookieOptions, CurrentPrincipal, type HttpRequest, type HttpResponse } from './http.js';
import { LoginRateLimiter } from './login-rate-limiter.js';
import { MAX_PASSWORD_LENGTH } from './password-hash.js';
import type { Principal } from './principal.js';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './session-token.js';
import { MAX_ADMIN_USERNAME_LENGTH } from '../config/app-config.js';

function parseLogin(body: unknown): { username: string; password: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new BadRequestException('Invalid request');
  const { username, password, ...rest } = body as Record<string, unknown>;
  if (
    Object.keys(rest).length > 0 ||
    typeof username !== 'string' ||
    typeof password !== 'string' ||
    username.length === 0 ||
    username.length > MAX_ADMIN_USERNAME_LENGTH ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_LENGTH
  ) {
    throw new BadRequestException('Invalid request');
  }
  return { username, password };
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(AuthorizationService) private readonly authorization: AuthorizationService,
    @Inject(LoginRateLimiter) private readonly limiter: LoginRateLimiter,
    @Inject(IdentityService) private readonly identity: IdentityService,
  ) {}

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: 'lax', secure: this.auth.secureCookies, path: '/' };
  }

  /** Public. The session token is delivered only in the Set-Cookie header, never in the body. */
  @Post('login')
  @HttpCode(200)
  async login(
    @Req() req: HttpRequest,
    @Res({ passthrough: true }) res: HttpResponse,
    @Body() body: unknown,
  ): Promise<AdminSessionDto> {
    const retryAfter = this.limiter.hit(req.ip ?? 'unknown');
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new HttpException('Too many login attempts', 429);
    }
    const { username, password } = parseLogin(body);
    if (!(await this.auth.verifyCredentials(username, password))) {
      throw new UnauthorizedException('Invalid credentials');
    }
    res.cookie(SESSION_COOKIE_NAME, this.auth.issueSessionToken(), {
      ...this.cookieOptions(),
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    return { kind: 'admin', username: this.auth.adminUsername };
  }

  @Post('logout')
  @HttpCode(204)
  logout(@CurrentPrincipal() principal: Principal, @Res({ passthrough: true }) res: HttpResponse): void {
    this.authorization.assertCan(principal, 'session:end', globalScope());
    res.clearCookie(SESSION_COOKIE_NAME, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentPrincipal() principal: Principal, @Res({ passthrough: true }) res: HttpResponse): Promise<SessionDto> {
    this.authorization.assertCan(principal, 'session:read', globalScope());
    res.setHeader('Cache-Control', 'no-store');
    return this.identity.describe(principal);
  }
}
