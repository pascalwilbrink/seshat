import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Controller, Get, Inject, Injectable, type INestApplication, type LoggerService, Module, NotFoundException, Param } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import type { Permission } from '@seshat/domain';
import { vi } from 'vitest';
import { ApiKeysController } from '../../src/api-keys/api-keys.controller.js';
import { ApiKeysService } from '../../src/api-keys/api-keys.service.js';
import { type ApiKeyRecord, ApiKeyStore, GeneratedApiKey } from '../../src/api-keys/api-key.store.js';
import { generateApiKey } from '../../src/api-keys/api-key-crypto.js';
import { createApp } from '../../src/app.setup.js';
import { AuthController } from '../../src/auth/auth.controller.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { type Action, AuthorizationService } from '../../src/auth/authorization.service.js';
import { IdentityService } from '../../src/auth/identity.service.js';
import { CurrentPrincipal } from '../../src/auth/http.js';
import { CLOCK, LoginRateLimiter, systemClock } from '../../src/auth/login-rate-limiter.js';
import type { Principal } from '../../src/auth/principal.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/session-token.js';
import { SessionGuard } from '../../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { OverviewController } from '../../src/scopes/overview.controller.js';
import { OverviewService } from '../../src/scopes/overview.service.js';
import { WorkspaceScopePipe } from '../../src/scopes/scope-params.pipe.js';
import type { ScopeRef } from '../../src/scopes/scope-ref.js';
import { Workspace } from '../../src/workspaces/workspace.entity.js';
import { WorkspacesService } from '../../src/workspaces/workspace.service.js';
import { WorkspacesController } from '../../src/workspaces/workspaces.controller.js';
import { TEST_ADMIN_ENV } from '../fixtures/admin.js';

/** What the harness needs from a key store: the production ApiKeyStore, or a faithful in-memory stand-in. */
export type KeyStore = Pick<ApiKeyStore, 'create' | 'findByKey' | 'list' | 'update' | 'revoke' | 'touchLastUsed'>;

/**
 * Test-only action handler. It runs behind the REAL global guard and decides access through the REAL
 * AuthorizationService, exactly as a future resource service would. `handled` counts how often the action
 * handler body was reached, so tests can prove that authentication failures never get that far.
 * It is registered only in test modules; production modules never import this file.
 */
@Injectable()
export class ProbeService {
  handled = 0;
  existing = new Set<string>();
  constructor(@Inject(AuthorizationService) private readonly authorization: AuthorizationService) {}

  run(principal: Principal, action: string, scope: ScopeRef): { ok: true } {
    this.handled++;
    this.authorization.assertCan(principal, action as Action, scope);
    // Mirrors production resolution order: authorize first, then look the Workspace up.
    if (scope.kind === 'workspace' && !this.existing.has(scope.workspaceId)) throw new NotFoundException('Not Found');
    return { ok: true };
  }
}

@Controller('probe')
export class ProbeController {
  constructor(@Inject(ProbeService) private readonly probe: ProbeService) {}

  @Get('workspaces/:workspaceId/:action')
  inWorkspace(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('action') action: string,
  ) {
    return this.probe.run(principal, action, scope);
  }

  @Get('global/:action')
  inGlobal(@CurrentPrincipal() principal: Principal, @Param('action') action: string) {
    return this.probe.run(principal, action, { kind: 'global' });
  }
}

class CapturingLogger implements LoggerService {
  readonly lines: string[] = [];
  private push = (...a: unknown[]) => void this.lines.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));
  log = this.push;
  error = this.push;
  warn = this.push;
  debug = this.push;
  verbose = this.push;
  fatal = this.push;
}

export interface Raw {
  status: number;
  bytes: Buffer;
  text: string;
  headers: Record<string, string>;
  setCookie: string[];
}

export interface SecurityApp {
  base: string;
  adminCookie: string;
  probe: ProbeService;
  /** Everything the API wrote to its logger and to console.* while running. */
  output(): string;
  /** Raw HTTP call. `bearer` adds Authorization; `admin` adds the admin session cookie. */
  http(method: string, path: string, o?: { bearer?: string; admin?: boolean; body?: unknown; headers?: Record<string, string> }): Promise<Raw>;
  close(): Promise<void>;
}

export interface SecurityDeps {
  workspaceRepo: unknown;
  dataSource: unknown;
  keys: KeyStore;
  /** Optional hook: extra providers/controllers are not supported on purpose; the module is fixed. */
  existingWorkspaceIds?: () => Iterable<string>;
}

/** The real controllers, services, guard, filter and bootstrap configuration, plus the test-only probe. */
export async function bootSecurityApp(deps: SecurityDeps): Promise<SecurityApp> {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
    vi.stubEnv(k, v);
  }
  @Module({
    imports: [ConfigModule, EventEmitterModule.forRoot()],
    controllers: [AuthController, WorkspacesController, OverviewController, ApiKeysController, ProbeController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      LoginRateLimiter,
      IdentityService,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: deps.keys },
      AuthorizationService,
      { provide: getRepositoryToken(Workspace), useValue: deps.workspaceRepo },
      { provide: getDataSourceToken(), useValue: deps.dataSource },
      WorkspacesService,
      OverviewService,
      ApiKeysService,
      ProbeService,
    ],
  })
  class Root {}

  const logs = new CapturingLogger();
  const consoleOut: string[] = [];
  const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleOut.push(a.map((x) => (x instanceof Error ? `${x.name}: ${x.message}\n${x.stack}` : String(x))).join(' '))),
  );
  const app: INestApplication = await createApp(Root, { trustProxy: false }, logs);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const adminCookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  const probe = app.get(ProbeService);
  return {
    base,
    adminCookie,
    probe,
    output: () => [...logs.lines, ...consoleOut].join('\n'),
    async http(method, path, o = {}) {
      const headers: Record<string, string> = { ...(o.headers ?? {}) };
      if (o.bearer !== undefined) headers.authorization = `Bearer ${o.bearer}`;
      if (o.admin) headers.cookie = adminCookie;
      if (o.body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}${path}`, {
        method,
        headers,
        body: o.body === undefined ? undefined : typeof o.body === 'string' ? o.body : JSON.stringify(o.body),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        bytes,
        text: bytes.toString('utf8'),
        headers: Object.fromEntries([...res.headers.entries()].filter(([k]) => k !== 'set-cookie')),
        setCookie: res.headers.getSetCookie(),
      };
    },
    async close() {
      spies.forEach((s) => s.mockRestore());
      await app.close();
      vi.unstubAllEnvs();
    },
  };
}

/** In-memory Workspaces, as in the other DB-free HTTP tests, with a delete that cascades to the key store. */
export class MemoryKeyStore implements KeyStore {
  rows: Array<ApiKeyRecord & { secret: string }> = [];
  touches = 0;

  async create(input: { workspaceId: string; name: string; permissions: readonly Permission[]; expiresAt?: Date | null }) {
    const { key, prefix } = generateApiKey();
    const row = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      name: input.name,
      prefix,
      permissions: [...input.permissions],
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      revokedAt: null,
      secret: key,
    };
    this.rows.push(row);
    return new GeneratedApiKey(this.strip(row), key);
  }
  private strip({ secret: _s, ...record }: ApiKeyRecord & { secret: string }): ApiKeyRecord {
    return record;
  }
  async findByKey(presented: unknown) {
    const row = this.rows.find((r) => r.secret === presented);
    return row ? this.strip(row) : null;
  }
  async list(workspaceId: string) {
    return this.rows.filter((r) => r.workspaceId === workspaceId).map((r) => this.strip(r));
  }
  async update(workspaceId: string, id: string, changes: { name?: string; permissions?: readonly Permission[] }) {
    const row = this.rows.find((r) => r.id === id && r.workspaceId === workspaceId);
    if (!row) return 'not_found' as const;
    if (row.revokedAt) return 'revoked' as const;
    if (changes.name !== undefined) row.name = changes.name;
    if (changes.permissions) row.permissions = [...changes.permissions];
    return this.strip(row);
  }
  async revoke(workspaceId: string, id: string) {
    const row = this.rows.find((r) => r.id === id && r.workspaceId === workspaceId);
    if (!row) return null;
    row.revokedAt ??= new Date();
    return this.strip(row);
  }
  async touchLastUsed(id: string) {
    this.touches++;
    const row = this.rows.find((r) => r.id === id);
    if (row) row.lastUsedAt = new Date();
    return true;
  }
  deleteWorkspace(workspaceId: string) {
    this.rows = this.rows.filter((r) => r.workspaceId !== workspaceId);
  }
}
