import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { isPermission } from '@seshat/domain';
import { z } from 'zod';

/** Fixed, safe tool error messages. Nothing derived from a request, an exception message or a stack. */
export const MCP_ERROR_MESSAGES = {
  notFound: 'Not found.',
  badRequest: 'Invalid request.',
  tooLarge: 'Content is too large.',
  conflict: 'Conflict with the current state.',
  forbidden: 'Forbidden.',
  internal: 'Internal error.',
} as const;

/** Zod issue message that marks "this id is malformed": reported exactly like an id that does not exist. */
export const MCP_NOT_FOUND_ISSUE = 'mcp:not-found';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Schema for an id argument: a malformed id is a not-found error, never a validation message about its shape. */
export const mcpIdSchema = z.string().refine((v) => UUID_RE.test(v), { message: MCP_NOT_FOUND_ISSUE });

/** Thrown by tool handlers for a resource that is absent. */
export class McpNotFoundError extends Error {
  constructor() {
    super(MCP_ERROR_MESSAGES.notFound);
    this.name = 'McpNotFoundError';
  }
}

const SAFE_FIELD_RE = /^[A-Za-z0-9_.[\]-]{1,60}$/;

function fieldName(path: ReadonlyArray<PropertyKey>): string {
  const joined = path.map((p) => (typeof p === 'number' ? `[${p}]` : String(p))).join('.').replace(/\.\[/g, '[');
  // Record keys can be client text: only plain identifiers are ever named.
  return SAFE_FIELD_RE.test(joined) ? joined : '(input)';
}

/** "Invalid input: field a, field b[0]" — names fields only, never values or schema messages. */
export function validationMessage(error: z.ZodError): string {
  const names = new Set<string>();
  for (const issue of error.issues) names.add(issue.code === 'unrecognized_keys' ? '(unexpected field)' : fieldName(issue.path));
  return `Invalid input: ${[...names].slice(0, 10).join(', ')}.`;
}

export interface SafeToolError {
  message: string;
  kind: 'validation' | 'not_found' | 'forbidden' | 'bad_request' | 'too_large' | 'conflict' | 'internal';
}

/**
 * Maps any thrown value to a short fixed message. Zod failures name the field; a ForbiddenException names only the
 * permissions (from a strict allowlist shape); not found, malformed ids and foreign ids give one identical message;
 * everything else is generic. Never includes exception messages, stacks, SQL, paths, keys or request content.
 */
export function toSafeToolError(error: unknown): SafeToolError {
  if (error instanceof z.ZodError) {
    if (error.issues.length > 0 && error.issues.every((i) => i.message === MCP_NOT_FOUND_ISSUE)) {
      return { kind: 'not_found', message: MCP_ERROR_MESSAGES.notFound };
    }
    return { kind: 'validation', message: validationMessage(error) };
  }
  if (error instanceof McpNotFoundError || error instanceof NotFoundException) {
    return { kind: 'not_found', message: MCP_ERROR_MESSAGES.notFound };
  }
  if (error instanceof ForbiddenException) {
    const response = error.getResponse();
    const raw = typeof response === 'string' ? response : (response as { message?: unknown })?.message;
    const match = typeof raw === 'string' ? /^Missing permission: ([a-z:, ]+)$/.exec(raw) : null;
    const names = match?.[1]?.split(', ') ?? [];
    if (names.length > 0 && names.every(isPermission)) {
      return { kind: 'forbidden', message: `Missing permission: ${names.join(', ')}.` };
    }
    return { kind: 'forbidden', message: MCP_ERROR_MESSAGES.forbidden };
  }
  if (error instanceof BadRequestException) return { kind: 'bad_request', message: MCP_ERROR_MESSAGES.badRequest };
  if (error instanceof PayloadTooLargeException || (error instanceof HttpException && error.getStatus() === 413)) {
    return { kind: 'too_large', message: MCP_ERROR_MESSAGES.tooLarge };
  }
  if (error instanceof ConflictException) return { kind: 'conflict', message: MCP_ERROR_MESSAGES.conflict };
  return { kind: 'internal', message: MCP_ERROR_MESSAGES.internal };
}
