import { Badge } from '@/components/ui/badge';
import { StatusBadge } from './status-badge';
import type { MemoryDto, MemoryEmbeddingStatus } from '@/lib/api-types';

export function TypeBadge({ type }: { type: MemoryDto['type'] }) {
  return <Badge variant="outline">{type}</Badge>;
}

const EMBEDDING: Record<MemoryEmbeddingStatus, { label: string; variant: 'secondary' | 'success' | 'destructive' }> = {
  pending: { label: 'Embedding pending', variant: 'secondary' },
  ready: { label: 'Embedding ready', variant: 'success' },
  failed: { label: 'Embedding failed', variant: 'destructive' },
};

export function EmbeddingBadge({ status }: { status: MemoryEmbeddingStatus }) {
  const c = EMBEDDING[status];
  return <Badge variant={c.variant} data-embedding={status}>{c.label}</Badge>;
}

export function MemoryStatusBadge({ status }: { status: MemoryDto['status'] }) {
  return <StatusBadge status={status} />;
}

/** Who created the Memory, from server-owned provenance only. */
export function provenanceText(m: MemoryDto): string {
  const by = m.provenance.createdBy;
  const who = by.kind === 'admin' ? 'Admin' : `API key ${by.keyName ?? 'unknown'}`;
  const c = m.provenance.client;
  return c ? `${who} via ${c.name}${c.version ? ` ${c.version}` : ''}` : who;
}
