import { Module } from '@nestjs/common';
import { CollectionsModule } from '../collections/collections.module.js';
import { FilesModule } from '../files/files.module.js';
import { IngestionModule } from '../ingestion/ingestion.module.js';
import { MemoriesModule } from '../memories/memories.module.js';
import { SearchModule } from '../search/search.module.js';
import { TagsModule } from '../tags/tags.module.js';
import { McpModule } from './mcp.module.js';
import { McpReadTools } from './read-tools.js';

/** Registers the production MCP tools into the registry owned by `McpModule`. */
@Module({
  imports: [McpModule, FilesModule, IngestionModule, CollectionsModule, TagsModule, SearchModule, MemoriesModule],
  providers: [McpReadTools],
})
export class McpToolsModule {}
