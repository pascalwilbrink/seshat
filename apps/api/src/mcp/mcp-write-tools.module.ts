import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module.js';
import { MemoriesModule } from '../memories/memories.module.js';
import { McpModule } from './mcp.module.js';
import { McpWriteTools } from './mcp-write-tools.js';

/** Registers the writing MCP tools (upload_file, delete_file, remember, update_memory, forget) in the MCP registry. */
@Module({ imports: [McpModule, FilesModule, MemoriesModule], providers: [McpWriteTools] })
export class McpWriteToolsModule {}
