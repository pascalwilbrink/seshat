import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { type INestApplication, type LoggerService, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { EventEmitter2, EventEmitterModule } from '@nestjs/event-emitter';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { vi } from 'vitest';
import { createApp } from '../../src/app.setup.js';
import { ApiKeyStore } from '../../src/api-keys/api-key.store.js';
import { AuthService } from '../../src/auth/auth.service.js';
import { type Action, AuthorizationService } from '../../src/auth/authorization.service.js';
import { CLOCK, systemClock } from '../../src/auth/login-rate-limiter.js';
import type { Principal } from '../../src/auth/principal.js';
import { SESSION_COOKIE_NAME } from '../../src/auth/session-token.js';
import { SessionGuard } from '../../src/auth/session.guard.js';
import { SanitizedExceptionFilter } from '../../src/common/sanitized-exception.filter.js';
import { ConfigModule } from '../../src/config/config.module.js';
import { OverviewController } from '../../src/scopes/overview.controller.js';
import { OverviewService } from '../../src/scopes/overview.service.js';
import type { ScopeRef } from '../../src/scopes/scope-ref.js';
import { WorkspacesService } from '../../src/workspaces/workspace.service.js';
import { Workspace } from '../../src/workspaces/workspace.entity.js';
import { WorkspacesController } from '../../src/workspaces/workspaces.controller.js';
import { TEST_ADMIN_ENV } from '../fixtures/admin.js';

/** Test-only policy: refuses the listed actions with the production denial behaviour (injected, not a fake principal). */
export class DenyingAuthorization extends AuthorizationService {
  constructor(private readonly denied: ReadonlySet<Action> | 'all') {
    super();
  }
  override can(principal: Principal, action: Action, scope: ScopeRef): boolean {
    if (this.denied === 'all' || this.denied.has(action)) return false;
    return super.can(principal, action, scope);
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

export interface WorkspaceApp {
  base: string;
  cookie: string;
  events: EventEmitter2;
  logs: CapturingLogger;
  request(method: string, path: string, body?: unknown, opts?: { cookie?: string | null }): Promise<{ status: number; text: string; json: any }>;
  close(): Promise<void>;
}

/** Boots the real controllers/services/guard/filter/bootstrap config around the supplied repository and data source. */
export async function bootWorkspaceApp(opts: {
  repo: unknown;
  dataSource: unknown;
  authorization?: AuthorizationService;
  /** Stand-in for the API key store the guard authenticates bearer keys with. */
  apiKeys?: Pick<ApiKeyStore, 'findByKey' | 'touchLastUsed'>;
}): Promise<WorkspaceApp> {
  for (const [k, v] of Object.entries({ DATABASE_URL: 'postgres://u:p@localhost:5432/db', ...TEST_ADMIN_ENV, NODE_ENV: 'test' })) {
    vi.stubEnv(k, v);
  }
  @Module({
    imports: [ConfigModule, EventEmitterModule.forRoot()],
    controllers: [WorkspacesController, OverviewController],
    providers: [
      { provide: CLOCK, useValue: systemClock },
      AuthService,
      SessionGuard,
      { provide: APP_GUARD, useExisting: SessionGuard },
      { provide: APP_FILTER, useClass: SanitizedExceptionFilter },
      { provide: ApiKeyStore, useValue: opts.apiKeys ?? { findByKey: async () => null, touchLastUsed: async () => false } },
      { provide: AuthorizationService, useValue: opts.authorization ?? new AuthorizationService() },
      { provide: getRepositoryToken(Workspace), useValue: opts.repo },
      { provide: getDataSourceToken(), useValue: opts.dataSource },
      WorkspacesService,
      OverviewService,
    ],
  })
  class TestRoot {}

  const logs = new CapturingLogger();
  const app: INestApplication = await createApp(TestRoot, { trustProxy: false }, logs);
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  const cookie = `${SESSION_COOKIE_NAME}=${app.get(AuthService).issueSessionToken()}`;
  return {
    base,
    cookie,
    events: app.get(EventEmitter2),
    logs,
    async request(method, path, body, o = {}) {
      const c = o.cookie === undefined ? cookie : o.cookie;
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(c ? { cookie: c } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      return { status: res.status, text, json };
    },
    close: () => app.close(),
  };
}

/** In-memory stand-in for the Workspace repository + delete transaction (DB-free tests). */
export class InMemoryWorkspaces {
  rows: Workspace[] = [];
  failNextDelete: unknown = undefined;

  private uniq(): never {
    throw Object.assign(new Error('duplicate key value violates unique constraint "UQ_workspaces_slug" SENTINEL-driver'), {
      driverError: { code: '23505' },
    });
  }

  repo = {
    find: async () => [...this.rows].sort((a, b) => a.name.localeCompare(b.name)),
    findOne: async ({ where }: { where: { id: string } }) => this.rows.find((r) => r.id === where.id) ?? null,
    create: (v: Partial<Workspace>) => ({ ...v }) as Workspace,
    save: async (w: Workspace) => {
      if (this.rows.some((r) => r.slug === w.slug && r.id !== w.id)) this.uniq();
      if (!w.id) {
        w.id = randomUUID();
        w.createdAt = new Date();
        this.rows.push(w);
      }
      w.updatedAt = new Date();
      return w;
    },
  };

  dataSource = {
    transaction: async (fn: (m: unknown) => Promise<unknown>) => {
      if (this.failNextDelete !== undefined) {
        const e = this.failNextDelete;
        this.failNextDelete = undefined;
        throw e;
      }
      return fn({
        delete: async (_e: unknown, where: { id: string }) => {
          const before = this.rows.length;
          this.rows = this.rows.filter((r) => r.id !== where.id);
          return { affected: before - this.rows.length };
        },
      });
    },
  };
}
