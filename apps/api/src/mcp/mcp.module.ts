import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry } from './mcp-registry.js';
import { McpController } from './mcp.controller.js';
import { McpService } from './mcp.service.js';

/**
 * The MCP transport. The production registry is empty in this module: tool modules import McpModule, inject
 * MCP_TOOL_REGISTRY and register their tools. Test-only tools are never registered here.
 */
@Module({
  imports: [AuthModule],
  controllers: [McpController],
  providers: [McpService, { provide: MCP_TOOL_REGISTRY, useFactory: () => new McpToolRegistry() }],
  exports: [MCP_TOOL_REGISTRY, McpService],
})
export class McpModule {}
