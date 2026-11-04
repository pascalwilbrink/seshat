import type { ScopeRef } from '../scopes/scope-ref.js';

export const FILE_UPLOADED_EVENT = 'file.uploaded';

/** Emitted only after the upload transaction committed. Carries ids and the explicit scope, never content or keys. */
export interface FileUploadedEvent {
  id: string;
  scope: ScopeRef;
}

export const FILE_DELETED_EVENT = 'file.deleted';

/** Emitted only after the delete transaction committed (the row, joins and the cleanup intent are already persisted). */
export interface FileDeletedEvent {
  id: string;
  scope: ScopeRef;
}
