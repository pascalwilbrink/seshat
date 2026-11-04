import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ACTIONS,
  GLOBAL_READ_PERMISSION,
  getActionRequirement,
  type ActionRequirement,
  isAction,
  isPermission,
  type Action,
  type Permission,
} from '@seshat/domain';
import type { ScopeRef } from '../scopes/scope-ref.js';
import { isUuid } from '../scopes/scope-ref.js';
import type { ApiKeyPrincipal, Principal } from './principal.js';

// The action catalog lives in the shared domain package so the guard, this policy and the UI agree.
export { ACTIONS };
export type { Action };

type Decision =
  | { allow: true }
  | { allow: false; reason: 'hidden' }
  | { allow: false; reason: 'forbidden'; missing?: readonly Permission[] };

const ALLOW: Decision = { allow: true };
const HIDDEN: Decision = { allow: false, reason: 'hidden' };
const FORBIDDEN: Decision = { allow: false, reason: 'forbidden' };

/** The operation permissions of a requirement (one, or any of several). Empty for admin and self actions. */
function requiredPermissions(req: ActionRequirement): readonly Permission[] {
  if ('permission' in req) return [req.permission];
  if ('anyOf' in req) return req.anyOf;
  return [];
}

/**
 * The read permissions of an action's resource family (`file.*`, `collection.*`, `tag.*`). A key sees a concealed family
 * in Global only with `global:read` plus one of these, so a Global mutation is a 403 for a key that can already read
 * Global and the generic 404 for one that cannot.
 */
function familyReadPermissions(action: Action): readonly Permission[] {
  const family = action.split('.')[0];
  const found = new Set<Permission>();
  for (const other of ACTIONS) {
    const req = getActionRequirement(other);
    if (!req || req.classification !== 'read' || other.split('.')[0] !== family) continue;
    for (const p of requiredPermissions(req)) found.add(p);
  }
  return [...found];
}

function asApiKeyPrincipal(principal: unknown): ApiKeyPrincipal | null {
  const p = principal as Partial<ApiKeyPrincipal> | null | undefined;
  if (!p || p.kind !== 'apiKey') return null;
  if (typeof p.keyId !== 'string' || !isUuid(p.workspaceId)) return null;
  if (!Array.isArray(p.permissions) || !p.permissions.every(isPermission)) return null;
  return p as ApiKeyPrincipal;
}

/**
 * The single access-policy point. All access decisions go through `assertCan(principal, action, scope)`.
 * It fails closed: unknown principal kinds, unknown actions and unrecognized scopes are denied.
 *
 * Denial never discloses Workspaces: a Workspace scope the principal may not use throws the same
 * NotFoundException a missing Workspace produces. Global scope denies with 403, except for resource families that conceal Global (files, Collections, Tags): there a
 * key without the Global read grant gets the same 404 a missing resource produces. Only inside a scope the
 * principal may use, a missing permission is a 403 that names the permission needed and nothing else.
 */
@Injectable()
export class AuthorizationService {
  can(principal: Principal, action: Action, scope: ScopeRef): boolean {
    return this.decide(principal, action, scope).allow;
  }

  assertCan(principal: Principal, action: Action, scope: ScopeRef): void {
    // `can` stays the single yes/no entry point (subclasses may tighten it); `decide` only shapes the denial.
    if (this.can(principal, action, scope)) return;
    const decision = this.decide(principal, action, scope);
    if (decision.allow) {
      if (scope?.kind === 'workspace') throw new NotFoundException('Not Found');
      throw new ForbiddenException('Forbidden');
    }
    // A key addressing another Workspace and a Workspace that does not exist look identical.
    if (decision.reason === 'hidden') throw new NotFoundException('Not Found');
    if (decision.missing?.length) throw new ForbiddenException(`Missing permission: ${decision.missing.join(', ')}`);
    throw new ForbiddenException('Forbidden');
  }

  private decide(principal: Principal, action: Action, scope: ScopeRef): Decision {
    const kind = (principal as { kind?: unknown } | null | undefined)?.kind;
    const inWorkspace = scope?.kind === 'workspace';
    if (!isAction(action)) return inWorkspace ? HIDDEN : FORBIDDEN;
    if (scope?.kind !== 'global' && scope?.kind !== 'workspace') return FORBIDDEN;
    switch (kind) {
      case 'admin':
        // Admins may do everything in the catalog.
        return ALLOW;
      case 'apiKey': {
        const key = asApiKeyPrincipal(principal);
        return key ? this.decideApiKey(key, action, scope) : inWorkspace ? HIDDEN : FORBIDDEN;
      }
      default:
        return inWorkspace ? HIDDEN : FORBIDDEN;
    }
  }

  private decideApiKey(key: ApiKeyPrincipal, action: Action, scope: ScopeRef): Decision {
    const req = getActionRequirement(action);
    if (!req) return scope.kind === 'workspace' ? HIDDEN : FORBIDDEN;

    if (scope.kind === 'workspace') {
      // Before any permission check: another Workspace is indistinguishable from a missing one.
      if (scope.workspaceId.toLowerCase() !== key.workspaceId.toLowerCase()) return HIDDEN;
      const needed = requiredPermissions(req);
      if (needed.length === 0) return FORBIDDEN;
      return needed.some((p) => key.permissions.includes(p)) ? ALLOW : { allow: false, reason: 'forbidden', missing: needed };
    }

    // Global: identity lookups, and reads that hold both the operation permission and the global:read grant.
    if (req.classification === 'self') return ALLOW;
    const needed = requiredPermissions(req);
    const holdsOperation = needed.some((p) => key.permissions.includes(p));
    const holdsGrant = key.permissions.includes(GLOBAL_READ_PERMISSION);
    if ('concealGlobal' in req && req.concealGlobal) {
      // Resource families: Global without the grant is indistinguishable from a missing resource.
      if (req.classification === 'read') return holdsOperation && holdsGrant ? ALLOW : HIDDEN;
      const canSee = holdsGrant && familyReadPermissions(action).some((p) => key.permissions.includes(p));
      return canSee ? FORBIDDEN : HIDDEN; // keys never mutate Global, even with every grant
    }
    if (req.classification !== 'read' || needed.length === 0) return FORBIDDEN;
    const missing: Permission[] = [];
    if (!holdsOperation) missing.push(...needed);
    if (!holdsGrant) missing.push(GLOBAL_READ_PERMISSION);
    return missing.length === 0 ? ALLOW : { allow: false, reason: 'forbidden', missing };
  }
}
