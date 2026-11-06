import { MEMORY_TYPES } from '../memories/memory.entity.js';
import { INGESTION_STATUSES } from '../files/file.entity.js';

/**
 * Deny-by-default argument summaries for MCP call history.
 *
 * Each tool has an explicit allowlist of fields; a field is copied only when it passes its own typed check (an id in
 * UUID form, a member of a closed enum, a bounded number, a boolean). Anything else is dropped without a trace: the
 * raw arguments are never spread or copied, and nothing derived from free text (queries, content, titles, metadata,
 * tag names, cursors, file bytes) is stored. This runs on the raw, unvalidated arguments so invalid calls are
 * summarized by the same rules and a validation failure cannot leak the offending value. A tool without an entry
 * (unknown, hidden or newly added) summarizes to `{}`.
 *
 * Upload is the one place where user-chosen text is allowed: the base file name (the spec permits file name and size
 * for uploads), cut to 200 characters, and the byte size.
 */
type Check = (value: unknown) => string | number | boolean | string[] | undefined;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LIST = 50;

const uuid: Check = (v) => (typeof v === 'string' && UUID_RE.test(v) ? v.toLowerCase() : undefined);
const bool: Check = (v) => (typeof v === 'boolean' ? v : undefined);
const int =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
const num =
  (min: number, max: number): Check =>
  (v) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : undefined;
const oneOf =
  (values: readonly string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v) ? v : undefined;
const listOf =
  (item: Check): Check =>
  (v) => {
    if (!Array.isArray(v)) return undefined;
    const out: string[] = [];
    for (const entry of v.slice(0, MAX_LIST)) {
      const checked = item(entry);
      if (typeof checked === 'string') out.push(checked);
    }
    return out.length > 0 ? out : undefined;
  };
/** Number of entries only (never the entries). */
const count: Check = (v) => (Array.isArray(v) ? Math.min(v.length, 1000) : undefined);

const scope = oneOf(['workspace', 'global']);
const memoryType = oneOf(MEMORY_TYPES);
const searchTypes = listOf(oneOf(['files', 'memories']));

const SEARCH_COMMON = {
  types: searchTypes,
  includeGlobal: bool,
  collectionIds: listOf(uuid),
  fileIds: listOf(uuid),
  tagMatch: oneOf(['any', 'all']),
  memoryTypes: listOf(memoryType),
  includeSuperseded: bool,
  limit: int(1, 1000),
  minScore: num(0, 1),
} satisfies Record<string, Check>;

/** `field -> check`, or `summaryKey: [sourceField, check]` for derived values. */
const ALLOWLIST: Record<string, Record<string, Check>> = {
  list_files: { scope, collectionId: uuid, status: oneOf(INGESTION_STATUSES), limit: int(1, 1000) },
  get_file: { fileId: uuid, scope },
  get_file_chunks: { fileId: uuid, scope, limit: int(1, 1000) },
  list_collections: { scope },
  list_tags: { scope },
  search_knowledge: { ...SEARCH_COMMON },
  get_context: { ...SEARCH_COMMON, maxChars: int(1, 1_000_000) },
  recall: { ...SEARCH_COMMON },
  list_memories: { scope, type: memoryType, status: oneOf(['active', 'superseded', 'all']), limit: int(1, 1000) },
  get_related_memories: { memoryId: uuid, limit: int(1, 1000), type: listOf(memoryType), includeGlobal: bool },
  delete_file: { id: uuid },
  forget: { id: uuid },
  remember: { type: memoryType, confidence: num(0, 1), supersedes: uuid },
  update_memory: { id: uuid, type: memoryType, confidence: num(0, 1) },
};

/** Counts of list-valued free-text fields (tag names): only how many, never which. */
const COUNTS: Record<string, Record<string, string>> = {
  remember: { tags: 'tagCount' },
  update_memory: { tags: 'tagCount' },
  upload_file: { tags: 'tagCount' },
};

function base64Bytes(b64: string): number {
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length / 4) * 3) - padding);
}

function uploadSummary(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof args.name === 'string') {
    // Only the base name, no control characters, bounded.
    const base = args.name.split(/[\\/]/).pop() ?? '';
    // eslint-disable-next-line no-control-regex
    const clean = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
    if (clean) out.fileName = clean;
  }
  if (typeof args.text === 'string' && args.base64 === undefined) {
    out.sizeBytes = Buffer.byteLength(args.text, 'utf8');
    out.encoding = 'text';
  } else if (typeof args.base64 === 'string' && args.text === undefined) {
    out.sizeBytes = base64Bytes(args.base64);
    out.encoding = 'base64';
  }
  const collectionId = uuid(args.collectionId);
  if (collectionId !== undefined) out.collectionId = collectionId;
  return out;
}

/** The safe summary of `args` for `tool`. Never throws, never returns anything but scalars and scalar arrays. */
export function summarizeArgs(tool: string, args: unknown): Record<string, unknown> {
  try {
    if (typeof args !== 'object' || args === null || Array.isArray(args)) return {};
    const record = args as Record<string, unknown>;
    if (tool === 'upload_file') {
      const out = uploadSummary(record);
      const tagCount = count(record.tags);
      if (tagCount !== undefined) out.tagCount = tagCount;
      return out;
    }
    const allowed = ALLOWLIST[tool];
    if (!allowed) return {};
    const out: Record<string, unknown> = {};
    for (const [field, check] of Object.entries(allowed)) {
      if (!Object.prototype.hasOwnProperty.call(record, field)) continue;
      const value = check(record[field]);
      if (value !== undefined) out[field] = value;
    }
    for (const [field, key] of Object.entries(COUNTS[tool] ?? {})) {
      const n = count(record[field]);
      if (n !== undefined) out[key] = n;
    }
    return out;
  } catch {
    return {};
  }
}

/** Tools that have an allowlist (tests assert every registered tool is covered). */
export const SUMMARIZED_TOOLS: readonly string[] = [...Object.keys(ALLOWLIST), 'upload_file'];
