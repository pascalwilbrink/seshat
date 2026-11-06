import { BadRequestException, ConflictException, ForbiddenException, InternalServerErrorException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MCP_ERROR_MESSAGES, McpNotFoundError, mcpIdSchema, toSafeToolError } from './mcp-errors.js';

const SENTINEL = 'SENTINEL-leak-5b1e /var/lib/secret.sql SELECT * FROM keys sk_seshat_AAAA_BBBB';

describe('toSafeToolError', () => {
  it('names the field of a zod failure and nothing else', () => {
    const schema = z.object({ query: z.string().min(1), limit: z.number().int().max(5), tags: z.array(z.string()) });
    const parsed = schema.safeParse({ query: '', limit: 99, tags: [3] });
    expect(parsed.success).toBe(false);
    const err = toSafeToolError((parsed as { error: z.ZodError }).error);
    expect(err.kind).toBe('validation');
    expect(err.message).toBe('Invalid input: query, limit, tags[0].');
  });

  it('never echoes client-chosen record keys or unexpected field names', () => {
    const schema = z.strictObject({ metadata: z.record(z.string(), z.number()) });
    const bad = schema.safeParse({ metadata: { [SENTINEL]: 'x' }, [SENTINEL + '2']: 1 });
    expect(bad.success).toBe(false);
    const message = toSafeToolError((bad as { error: z.ZodError }).error).message;
    expect(message).not.toContain('SENTINEL');
  });

  it('names only permissions for a forbidden error', () => {
    expect(toSafeToolError(new ForbiddenException('Missing permission: search, files:read')).message).toBe('Missing permission: search, files:read.');
    expect(toSafeToolError(new ForbiddenException(`Missing permission: ${SENTINEL}`)).message).toBe(MCP_ERROR_MESSAGES.forbidden);
    expect(toSafeToolError(new ForbiddenException(SENTINEL)).message).toBe(MCP_ERROR_MESSAGES.forbidden);
  });

  it('reports missing, foreign and malformed ids with one identical message', () => {
    const missing = toSafeToolError(new NotFoundException(SENTINEL));
    const own = toSafeToolError(new McpNotFoundError());
    const malformed = mcpIdSchema.safeParse('not-a-uuid');
    expect(malformed.success).toBe(false);
    const malformedErr = toSafeToolError((malformed as { error: z.ZodError }).error);
    expect(mcpIdSchema.safeParse('3f2b8c1e-0000-4000-8000-000000000001').success).toBe(true);
    for (const e of [missing, own, malformedErr]) expect(e).toEqual({ kind: 'not_found', message: MCP_ERROR_MESSAGES.notFound });
  });

  it('maps the remaining exceptions to fixed messages and never leaks a sentinel', () => {
    const cases: unknown[] = [
      new BadRequestException(SENTINEL),
      new PayloadTooLargeException(SENTINEL),
      new ConflictException(SENTINEL),
      new InternalServerErrorException(SENTINEL),
      Object.assign(new Error(SENTINEL), { stack: SENTINEL, code: SENTINEL }),
      SENTINEL,
      null,
    ];
    for (const c of cases) expect(toSafeToolError(c).message).not.toContain('SENTINEL');
    expect(toSafeToolError(new Error(SENTINEL))).toEqual({ kind: 'internal', message: MCP_ERROR_MESSAGES.internal });
    expect(toSafeToolError(new BadRequestException(SENTINEL)).message).toBe(MCP_ERROR_MESSAGES.badRequest);
    expect(toSafeToolError(new PayloadTooLargeException()).message).toBe(MCP_ERROR_MESSAGES.tooLarge);
    expect(toSafeToolError(new ConflictException()).message).toBe(MCP_ERROR_MESSAGES.conflict);
  });
});
