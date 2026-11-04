import { BadRequestException, type PipeTransform } from '@nestjs/common';
import { InvalidScopeError, type ScopeRef, workspaceScope } from './scope-ref.js';

/** Turns the `:workspaceId` path segment into a validated Workspace `ScopeRef`; anything but a UUID is a 400. */
export class WorkspaceScopePipe implements PipeTransform<unknown, ScopeRef> {
  transform(value: unknown): ScopeRef {
    try {
      return workspaceScope(value);
    } catch (err) {
      if (err instanceof InvalidScopeError) throw new BadRequestException('Invalid workspace id');
      throw err;
    }
  }
}
