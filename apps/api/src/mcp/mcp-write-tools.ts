import { Inject, Injectable, type OnModuleInit, PayloadTooLargeException } from '@nestjs/common';
import { MCP_TOOL_CATALOG } from '@seshat/domain';
import { z } from 'zod';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { FILE_NAME_MAX_LENGTH } from '../files/file-name.js';
import { FilesService } from '../files/files.service.js';
import { createMemorySchema, updateMemorySchema } from '../memories/memory.dto.js';
import { MemoriesService } from '../memories/memories.service.js';
import { mcpIdSchema } from './mcp-errors.js';
import { MCP_TOOL_REGISTRY, McpToolRegistry, type McpToolDefinition } from './mcp-registry.js';
import { wrapRetrieved } from './mcp-results.js';

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decoded size of a (validated) base64 string, computed without decoding it. */
export function base64DecodedLength(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - padding;
}

/**
 * Writing tools (spec seshat-mcp-server, AC-3/5/7/8). They act in the key's Workspace only: the schemas are strict, so
 * a `scope` or Global option is an unknown field, and the scope comes from the handler context. Permissions, kinds and
 * annotations come from the browser-safe domain catalog, so the tool preview and the server cannot drift apart.
 */
@Injectable()
export class McpWriteTools implements OnModuleInit {
  constructor(
    @Inject(MCP_TOOL_REGISTRY) private readonly registry: McpToolRegistry,
    @Inject(FilesService) private readonly files: FilesService,
    @Inject(MemoriesService) private readonly memories: MemoriesService,
    @Inject(APP_CONFIG) private readonly config: Pick<AppConfig, 'mcpMaxUploadBytes'>,
  ) {}

  onModuleInit(): void {
    for (const tool of this.definitions()) this.registry.register(tool);
  }

  definitions(): McpToolDefinition[] {
    const maxUpload = this.config.mcpMaxUploadBytes;

    const uploadSchema = z
      .strictObject({
        name: z.string().trim().min(1).max(FILE_NAME_MAX_LENGTH * 4).describe('File name, for example "notes.md". Only the base name is kept.'),
        text: z.string().optional().describe('UTF-8 text content. Provide exactly one of text or base64.'),
        base64: z.string().optional().describe('Base64 (standard alphabet, padded) content for binary files. Provide exactly one of text or base64.'),
        collectionId: z.string().nullish().describe('Optional Collection of this Workspace.'),
        tags: z.array(z.string()).max(100).optional().describe('Optional tag names.'),
      })
      .refine((v) => (v.text === undefined) !== (v.base64 === undefined), { message: 'Provide exactly one of text or base64', path: ['text'] })
      .refine((v) => v.base64 === undefined || BASE64_RE.test(v.base64), { message: 'Invalid base64', path: ['base64'] });

    const rememberSchema = z.strictObject({ ...createMemorySchema.shape, supersedes: mcpIdSchema.nullish() });
    const updateSchema = z.strictObject({ id: mcpIdSchema, ...updateMemorySchema.shape });
    const idSchema = z.strictObject({ id: mcpIdSchema });
    const asMemoryText = (id: string, structured: Record<string, unknown>) => wrapRetrieved(`memory ${id}`, JSON.stringify(structured, null, 2));
    const entry = <N extends keyof typeof MCP_TOOL_CATALOG>(name: N) => MCP_TOOL_CATALOG[name];

    const upload: McpToolDefinition<typeof uploadSchema> = {
      name: 'upload_file',
      description: `Upload a file to this Workspace (needs files:write). Give exactly one of "text" (UTF-8) or "base64" (binary). Decoded size is capped at ${maxUpload} bytes. The file starts as "pending" and is indexed in the background; its status is in the result. Never writes to Global.`,
      inputSchema: uploadSchema,
      kind: entry('upload_file').kind,
      requires: entry('upload_file').requires,
      actions: ['file.upload'],
      handler: async (input, ctx) => {
        let content: Buffer;
        if (input.text !== undefined) {
          if (Buffer.byteLength(input.text, 'utf8') > maxUpload) throw new PayloadTooLargeException('Payload too large');
          content = Buffer.from(input.text, 'utf8');
        } else {
          const b64 = input.base64!;
          if (base64DecodedLength(b64) > maxUpload) throw new PayloadTooLargeException('Payload too large');
          content = Buffer.from(b64, 'base64');
        }
        const file = await this.files.uploadBuffer(
          ctx.principal,
          ctx.scope,
          { name: input.name, mimeType: input.text !== undefined ? 'text/plain' : 'application/octet-stream', content, collectionId: input.collectionId, tags: input.tags },
          ctx.client,
          maxUpload,
        );
        return { structured: { file } };
      },
    };

    const del: McpToolDefinition<typeof idSchema> = {
      name: 'delete_file',
      description: 'Permanently delete a file of this Workspace, with its chunks and stored original (needs files:delete). This cannot be undone.',
      inputSchema: idSchema,
      kind: entry('delete_file').kind,
      requires: entry('delete_file').requires,
      actions: ['file.delete'],
      handler: async (input, ctx) => {
        await this.files.remove(ctx.principal, ctx.scope, input.id);
        return { structured: { deleted: true, id: input.id } };
      },
    };

    const remember: McpToolDefinition<typeof rememberSchema> = {
      name: 'remember',
      description:
        'Store a persistent memory in this Workspace (needs memories:write): type (fact, decision, preference, experience, procedure, context) and content, optionally title, tags, confidence (0-1), source, metadata and "supersedes" (id of an active memory this one replaces). An identical active memory is reused (deduplicated: true). The result lists up to three similar memories as hints; nothing is merged automatically.',
      inputSchema: rememberSchema,
      kind: entry('remember').kind,
      requires: entry('remember').requires,
      actions: ['memory.remember'],
      handler: async (input, ctx) => {
        const memory = await this.memories.create(ctx.principal, ctx.scope, input, ctx.client);
        return { structured: { ...memory }, text: asMemoryText(memory.id, { ...memory }) };
      },
    };

    const update: McpToolDefinition<typeof updateSchema> = {
      name: 'update_memory',
      description:
        'Replace a memory of this Workspace (needs memories:write). Full replacement: every field is required (type, content, title, metadata, confidence, source, tags); use null to clear title, metadata, confidence or source and [] to clear tags. A superseded memory cannot be changed.',
      inputSchema: updateSchema,
      kind: entry('update_memory').kind,
      requires: entry('update_memory').requires,
      actions: ['memory.update'],
      handler: async (input, ctx) => {
        const { id, ...body } = input;
        const memory = await this.memories.update(ctx.principal, ctx.scope, id, body);
        return { structured: { ...memory }, text: asMemoryText(memory.id, { ...memory }) };
      },
    };

    const forget: McpToolDefinition<typeof idSchema> = {
      name: 'forget',
      description: 'Permanently delete a memory of this Workspace (needs memories:delete). This cannot be undone.',
      inputSchema: idSchema,
      kind: entry('forget').kind,
      requires: entry('forget').requires,
      actions: ['memory.forget'],
      handler: async (input, ctx) => {
        await this.memories.remove(ctx.principal, ctx.scope, input.id);
        return { structured: { forgotten: true, id: input.id } };
      },
    };

    return [upload, del, remember, update, forget] as unknown as McpToolDefinition[];
  }
}
