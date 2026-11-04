import type { IncomingMessage } from 'node:http';
import { Controller, Inject, Param, Post, Req } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import type { FileDto } from './file.dto.js';
import { FilesService } from './files.service.js';

/**
 * `POST /api/global/files` and `POST /api/workspaces/:workspaceId/files`: `multipart/form-data` with one `file` part and
 * optional `collectionId` and repeated `tags` fields. The body is streamed, never parsed by a body parser.
 */
@Controller()
export class FilesController {
  constructor(@Inject(FilesService) private readonly files: FilesService) {}

  @Post('global/files')
  uploadGlobal(@CurrentPrincipal() principal: Principal, @Req() req: IncomingMessage): Promise<FileDto> {
    return this.files.upload(principal, globalScope(), req);
  }

  @Post('workspaces/:workspaceId/files')
  upload(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Req() req: IncomingMessage,
  ): Promise<FileDto> {
    return this.files.upload(principal, scope, req);
  }
}
