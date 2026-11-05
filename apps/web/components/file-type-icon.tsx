import * as React from 'react';
import { File, FileCode, FileJson, FileSpreadsheet, FileText, FileType, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export type FileKind = 'pdf' | 'markdown' | 'text' | 'docx' | 'json' | 'csv' | 'code' | 'unknown';

const KINDS: Record<FileKind, { label: string; icon: LucideIcon }> = {
  pdf: { label: 'PDF', icon: FileType },
  markdown: { label: 'Markdown', icon: FileText },
  text: { label: 'Text', icon: FileText },
  docx: { label: 'DOCX', icon: FileType },
  json: { label: 'JSON', icon: FileJson },
  csv: { label: 'CSV', icon: FileSpreadsheet },
  code: { label: 'Source code', icon: FileCode },
  unknown: { label: 'Unknown file type', icon: File },
};

const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'cs', 'php', 'sh', 'sql', 'html', 'css', 'yaml', 'yml', 'toml']);
const EXT_KIND: Record<string, FileKind> = { pdf: 'pdf', md: 'markdown', markdown: 'markdown', txt: 'text', docx: 'docx', json: 'json', csv: 'csv' };

/** Classify by MIME type first, then by the file name's extension. */
export function fileKind(name?: string | null, mimeType?: string | null): FileKind {
  const mime = (mimeType ?? '').split(';')[0]!.trim().toLowerCase();
  if (mime === 'application/pdf') return 'pdf';
  if (mime === 'text/markdown') return 'markdown';
  if (mime === 'text/plain') return 'text';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mime === 'application/json') return 'json';
  if (mime === 'text/csv') return 'csv';
  const ext = name && name.includes('.') ? name.split('.').pop()!.toLowerCase() : '';
  if (EXT_KIND[ext]) return EXT_KIND[ext]!;
  if (CODE_EXT.has(ext)) return 'code';
  return 'unknown';
}

export interface FileTypeIconProps extends Omit<React.ComponentProps<'svg'>, 'name'> {
  name?: string | null;
  mimeType?: string | null;
  /** Set when the icon is the only place the type is shown; otherwise it is decorative. */
  labelled?: boolean;
}

export function FileTypeIcon({ name, mimeType, labelled = false, className, ...props }: FileTypeIconProps) {
  const kind = fileKind(name, mimeType);
  const { label, icon: Icon } = KINDS[kind];
  return (
    <Icon
      data-kind={kind}
      className={cn('size-4 shrink-0 text-muted-foreground', className)}
      {...(labelled ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
      {...props}
    />
  );
}
