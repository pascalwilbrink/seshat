import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ScopeRef } from '../scopes/scope-ref.js';
import type { Principal } from './principal.js';

/**
 * Every action that needs an access decision. Add new actions here and give them explicit rules below.
 */
export const ACTIONS = [
  'session:read',
  'session:end',
  'overview:read',
  'workspace:list',
  'workspace:create',
  'workspace:read',
  'workspace:update',
  'workspace:delete',
] as const;
export type Action = (typeof ACTIONS)[number];

/** Admin rules: an explicit allow-list per action. Anything not listed is denied. */
const ADMIN_ALLOWED: ReadonlySet<Action> = new Set<Action>(ACTIONS);

/**
 * The single access-policy point. All access decisions go through `assertCan(principal, action, scope)`.
 * It fails closed: unknown principal kinds, unknown actions and unrecognized scopes are denied.
 *
 * Denial is non-disclosing for Workspace scope: it throws the same NotFoundException a missing Workspace
 * produces, so callers cannot tell "does not exist" from "not allowed". Global scope denies with 403.
 */
@Injectable()
export class AuthorizationService {
  can(principal: Principal, action: Action, scope: ScopeRef): boolean {
    const kind = (principal as { kind?: unknown } | null | undefined)?.kind;
    if (!ACTIONS.includes(action)) return false;
    if (scope?.kind !== 'global' && scope?.kind !== 'workspace') return false;
    switch (kind) {
      case 'admin':
        return ADMIN_ALLOWED.has(action);
      default:
        return false;
    }
  }

  assertCan(principal: Principal, action: Action, scope: ScopeRef): void {
    if (this.can(principal, action, scope)) return;
    if (scope?.kind === 'workspace') throw new NotFoundException('Not Found');
    throw new ForbiddenException('Forbidden');
  }
}
