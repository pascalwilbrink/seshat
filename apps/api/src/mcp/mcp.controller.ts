import type { IncomingMessage, ServerResponse } from 'node:http';
import { Controller, Delete, Get, Inject, Post, Req, Res } from '@nestjs/common';
import type { HttpRequest } from '../auth/http.js';
import type { ApiKeyPrincipal } from '../auth/principal.js';
import { MCP_PATH } from './mcp-limits.js';
import { McpService } from './mcp.service.js';

type McpRequest = IncomingMessage & HttpRequest;

/**
 * `/mcp` (outside the `api` prefix). Stateless Streamable HTTP: only POST is served; GET (server-initiated stream)
 * and DELETE (session end) answer 405 as the SDK's stateless guidance says. Authentication happens in SessionGuard,
 * which accepts only API keys here, so `req.principal` is always a key.
 */
@Controller(MCP_PATH.slice(1))
export class McpController {
  constructor(@Inject(McpService) private readonly mcp: McpService) {}

  @Post()
  async handle(@Req() req: McpRequest, @Res() res: ServerResponse): Promise<void> {
    await this.mcp.handle(req, res, req.body, req.principal as ApiKeyPrincipal);
  }

  @Get()
  notAllowedGet(@Res() res: ServerResponse): void {
    methodNotAllowed(res);
  }

  @Delete()
  notAllowedDelete(@Res() res: ServerResponse): void {
    methodNotAllowed(res);
  }
}

function methodNotAllowed(res: ServerResponse): void {
  res.statusCode = 405;
  res.setHeader('Allow', 'POST');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
}