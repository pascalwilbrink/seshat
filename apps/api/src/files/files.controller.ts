import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream';
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Put, Post, Query, Req, Res } from '@nestjs/common';
import { CurrentPrincipal } from '../auth/http.js';
import type { Principal } from '../auth/principal.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { WorkspaceScopePipe } from '../scopes/scope-params.pipe.js';
import { type ScopeRef, globalScope } from '../scopes/scope-ref.js';
import { attachmentDisposition, safeDownloadContentType } from './download-headers.js';
import type { FileListPage } from './file-list-query.js';
import { type FileDto, type UpdateFileInput, updateFileSchema } from './file.dto.js';
import { FilesService } from './files.service.js';

/**
 * `POST /api/global/files` and `POST /api/workspaces/:workspaceId/files`: `multipart/form-data` with one `file` part and
 * optional `collectionId` and repeated `tags` fields. The body is streamed, never parsed by a body parser.
 *
 * `GET .../files` lists (query: `limit`, `cursor`, `collectionId`, `tag`, `status`, `name`), `GET .../files/:fileId` returns
 * metadata and `GET .../files/:fileId/download` streams the original as an attachment.
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

  @Put('global/files/:fileId')
  updateGlobal(
    @CurrentPrincipal() principal: Principal,
    @Param('fileId') fileId: string,
    @Body(new ZodValidationPipe(updateFileSchema)) body: UpdateFileInput,
  ): Promise<FileDto> {
    return this.files.update(principal, globalScope(), fileId, body);
  }

  @Put('workspaces/:workspaceId/files/:fileId')
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
    @Body(new ZodValidationPipe(updateFileSchema)) body: UpdateFileInput,
  ): Promise<FileDto> {
    return this.files.update(principal, scope, fileId, body);
  }

  @Delete('global/files/:fileId')
  @HttpCode(204)
  removeGlobal(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string): Promise<void> {
    return this.files.remove(principal, globalScope(), fileId);
  }

  @Delete('workspaces/:workspaceId/files/:fileId')
  @HttpCode(204)
  remove(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
  ): Promise<void> {
    return this.files.remove(principal, scope, fileId);
  }

  @Get('global/files')
  listGlobal(@CurrentPrincipal() principal: Principal, @Query() query: unknown): Promise<FileListPage<FileDto>> {
    return this.files.list(principal, globalScope(), query);
  }

  @Get('workspaces/:workspaceId/files')
  list(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Query() query: unknown,
  ): Promise<FileListPage<FileDto>> {
    return this.files.list(principal, scope, query);
  }

  @Get('global/files/:fileId')
  getGlobal(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string): Promise<FileDto> {
    return this.files.get(principal, globalScope(), fileId);
  }

  @Get('workspaces/:workspaceId/files/:fileId')
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
  ): Promise<FileDto> {
    return this.files.get(principal, scope, fileId);
  }

  @Get('global/files/:fileId/download')
  downloadGlobal(@CurrentPrincipal() principal: Principal, @Param('fileId') fileId: string, @Res() res: ServerResponse): Promise<void> {
    return this.stream(principal, globalScope(), fileId, res);
  }

  @Get('workspaces/:workspaceId/files/:fileId/download')
  download(
    @CurrentPrincipal() principal: Principal,
    @Param('workspaceId', new WorkspaceScopePipe()) scope: ScopeRef,
    @Param('fileId') fileId: string,
    @Res() res: ServerResponse,
  ): Promise<void> {
    return this.stream(principal, scope, fileId, res);
  }

  /** Errors before the first byte go through the normal exception filter; after that the connection is destroyed. */
  private async stream(principal: Principal, scope: ScopeRef, fileId: string, res: ServerResponse): Promise<void> {
    const file = await this.files.openDownload(principal, scope, fileId);
    res.statusCode = 200;
    res.setHeader('Content-Type', safeDownloadContentType(file.mimeType));
    res.setHeader('Content-Disposition', attachmentDisposition(file.name));
    res.setHeader('Content-Length', String(file.sizeBytes));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cache-Control', 'private, no-store');
    // pipeline destroys both sides on a stream error or a client disconnect, so the file handle is always released.
    await new Promise<void>((resolve) => pipeline(file.stream, res, () => resolve()));
  }
}
