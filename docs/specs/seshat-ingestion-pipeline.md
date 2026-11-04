## Goal

Turn uploaded files into retrievable knowledge: extract text through pluggable ingestors, split it into chunks that keep a reference to their source file and location, embed them through the Vercel AI SDK with the OpenAI provider, and store them in pgvector, as durable background work whose state is visible and whose deletes leave nothing behind.

## Context

- Depends on `seshat-persistence-foundation` (TypeORM, pgvector helper, event emitter), `seshat-api-keys-authorization` (action catalog) and `seshat-files-collections-tags` (`files` with `ingestion_status` and `ingestion_error`, `FileStorage`, `file.uploaded` and `file.deleted` events).
- Decisions: pg-boss on the same Postgres for durable jobs; `@nestjs/event-emitter` for in-process events, with listeners enqueueing pg-boss jobs for slow or retryable work; embeddings through the AI SDK (`ai`, `embedMany`) with `@ai-sdk/openai`; model and dimension from configuration.
- The ingestion extension point in the README: `FileIngestor` with `forFileExtensions(): string[]` and an ingest method returning `Document[]`; `Document` has `content` and `metadata` (at least source file name, extension and position or chunk info); `FileIngestorProvider` receives all ingestors through a Nest multi-provider token and picks one by extension, case-insensitively; first a plain-text ingestor for `txt` and `md`.
- `AGENTS.md`: chunks keep a reference to their source file and location; ingestion states are observable (pending, processing, indexed, failed); deleting a source leaves no retrievable orphaned chunks or embeddings; file content is untrusted and never logged; the embedding provider and model stay configurable.

## Behaviour

Jobs. A pg-boss module starts pg-boss on `DATABASE_URL` in its own schema, registers workers on application start and stops them gracefully on shutdown. A `file.uploaded` listener enqueues an `ingest-file` job keyed by file id (singleton per file), with retries (3 attempts, exponential backoff). Concurrency comes from `INGESTION_CONCURRENCY` (default 2).

Ingestors. `FileIngestor`, `FileIngestorProvider` and `Document` are implemented as described in Context. The first ingestor handles `txt` and `md` as UTF-8 (a file that is not valid UTF-8 fails with a clear error). Adding an ingestor needs only a new provider registration under the token.

Chunking. A chunker splits each `Document` into chunks with configurable size and overlap (`CHUNK_SIZE_CHARS` default 2000, `CHUNK_OVERLAP_CHARS` default 200). Markdown is split on headings first and records the heading path as the chunk's section; all chunks record their character offsets and line range in the original. Empty chunks are dropped.

Embeddings. An `EmbeddingService` interface (`model`, `dimension`, `embed(texts: string[]): Promise<number[][]>`) with an implementation using `embedMany` and `openai.embedding(EMBEDDING_MODEL)`, batching inputs. Config: `OPENAI_API_KEY`, `EMBEDDING_MODEL` (default `text-embedding-3-small`), `EMBEDDING_DIMENSION` (default 1536). Domain code depends only on the interface. Tests use a deterministic fake and never call OpenAI.

Chunks. A `chunks` table: id, file id (foreign key with `ON DELETE CASCADE`), scope and workspace id copied from the file for filtering, ordinal, content, location metadata (JSON: section, heading path, character offsets, line range, page when an ingestor provides one), character count, content hash, embedding (`vector(1536)`), embedding model, created timestamp. Indexes: HNSW on the embedding with cosine distance, and btree on (`scope`, `workspace_id`) and on `file_id`. At startup the API checks that `EMBEDDING_DIMENSION` matches the column dimension and refuses to start with a clear message when it does not; changing the model's dimension requires a migration and a re-index, which the README documents.

Processing. The worker sets the file to `processing`, reads the original through `FileStorage`, picks the ingestor, chunks, embeds, and in one transaction replaces all of the file's chunks and sets `indexed` with an indexed timestamp and the chunk count. An unsupported extension sets `failed` with a clear, safe error ("No ingestor for .xyz") and is not retried. Provider and transient errors are retried; after the last attempt the file is `failed` with a short safe error that contains no content or secrets. If the file was deleted meanwhile, the job ends quietly without error. Processing is idempotent: running it twice yields the same chunks.

Re-index. `POST .../files/:id/reindex` (`files:write`) sets the file to `pending` and enqueues it; the admin can also re-index all files in a scope. Both go through `AuthorizationService` and are added to the action catalog.

Chunks API. `GET .../files/:id/chunks` (`files:read`) returns the file's chunks in order with content and location, paginated, without embeddings. It follows the same isolation rules as files.

Deletion. Deleting a file deletes its chunks in the same transaction through the cascade, so no chunk is ever retrievable for a deleted file; Workspace deletion therefore also removes chunks. A test proves no orphaned chunks remain after file and Workspace deletes.

UI. The Files table shows the ingestion status as a badge (pending, processing, indexed, failed), polls while any visible file is pending or processing, shows the error for failed files and offers "Re-index". The file detail panel shows chunk count, indexed time and a paged chunk preview with section and line range.

Logging. File contents, chunk contents and embeddings are never logged; logs use file ids, statuses and safe error codes.

## Acceptance criteria

- AC-1: pg-boss runs on the same database in its own schema with workers started and stopped with the application, and `file.uploaded` enqueues one `ingest-file` job per file with retries and configurable concurrency.
- AC-2: `FileIngestor`, `FileIngestorProvider` (Nest multi-provider, case-insensitive extension match) and `Document` exist as described, with a plain-text ingestor for `txt` and `md`, and adding an ingestor needs no change to the provider.
- AC-3: Chunks have configurable size and overlap, Markdown chunks record their heading path as section, and every chunk records its source file, ordinal, character offsets and line range.
- AC-4: Embeddings go through an `EmbeddingService` interface implemented with the AI SDK `embedMany` and `@ai-sdk/openai`, with model, dimension and API key from validated config, and tests use a deterministic fake.
- AC-5: The `chunks` table has a cascading foreign key to files, scope columns, location metadata, an HNSW cosine index and scope and file indexes, and the API refuses to start when `EMBEDDING_DIMENSION` does not match the column.
- AC-6: A file moves through pending, processing and indexed or failed; unsupported types fail without retry, transient errors retry, final failures store a safe error, deleted files end the job quietly, and re-running yields the same chunks.
- AC-7: Re-indexing one file (`files:write`) and all files in a scope (admin) is possible and authorized through `AuthorizationService`.
- AC-8: `GET .../files/:id/chunks` returns ordered chunks with content and location, without embeddings, under the same isolation rules as files.
- AC-9: Deleting a file or a Workspace leaves no chunks or embeddings behind, proven by tests.
- AC-10: The Files UI shows and polls ingestion status, shows errors with Re-index, and previews chunks; contents and embeddings are never logged; the README, `.env.example` and `AGENTS.md` section 10 document the pipeline, configuration and how to add an ingestor.

## Out of scope

- Search and retrieval endpoints (Search spec) and Memory embeddings (Memories spec).
- Ingestors for PDF, DOCX, JSON, CSV and source code.
- Embedding providers other than OpenAI and automatic re-indexing after a model change.

## Open questions

None.
