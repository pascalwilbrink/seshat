import type { ScopeRef } from '../scopes/scope-ref.js';

/** The kinds of knowledge a search can cover. `files` searches chunks of indexed files; `memories` searches Memories. */
export const SEARCH_TYPES = ['files', 'memories'] as const;
export type SearchType = (typeof SEARCH_TYPES)[number];

/**
 * The server-owned outcome of authorizing a search. Every retrieval query branch (vector and keyword, chunks and
 * Memories) must take its scope and type predicates from here and from nothing the client sent:
 * - `scopes`: the route scope first, then Global only when a Workspace request opted in with `includeGlobal` and the
 *   caller holds the Global grant. Granting Global never adds it by default.
 * - `types`: only the requested types the caller may read.
 * Instances are frozen and are produced only by `AuthorizationService.authorizeSearch`.
 */
export interface AuthorizedSearchPlan {
  readonly scopes: readonly ScopeRef[];
  readonly types: readonly SearchType[];
}

/** What a caller asks the policy to authorize (already validated request values). */
export interface SearchAuthorizationRequest {
  readonly types: readonly SearchType[];
  /** Only meaningful on a Workspace route; ignored (never widens anything) on the Global route. */
  readonly includeGlobal: boolean;
}
