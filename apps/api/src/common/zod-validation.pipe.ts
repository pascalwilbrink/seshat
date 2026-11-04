import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Codes whose zod message is fixed text that never echoes the submitted value. */
const SAFE_MESSAGE_CODES = new Set(['too_small', 'too_big', 'invalid_type', 'invalid_format', 'custom']);

/**
 * Validates a request value with a zod schema at the HTTP boundary. The 400 body names fields and fixed
 * reasons only: it never contains the submitted values, so secrets in a body cannot be reflected.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    throw new BadRequestException({
      statusCode: 400,
      message: 'Invalid request',
      issues: result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message:
          issue.code === 'unrecognized_keys'
            ? 'Unknown field'
            : SAFE_MESSAGE_CODES.has(issue.code)
              ? issue.message
              : 'Invalid value',
      })),
    });
  }
}
