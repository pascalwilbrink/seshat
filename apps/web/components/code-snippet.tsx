'use client';
import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyWithToast } from '@/components/copy-field';
import { cn } from '@/lib/utils';

export interface CodeSnippetProps {
  code: string;
  /** Names the block and the copy button, e.g. "Claude Code configuration". */
  label: string;
  className?: string;
}

/** Monospace block with a copy button. Long lines scroll inside the block, never the page. */
export function CodeSnippet({ code, label, className }: CodeSnippetProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  async function onCopy() {
    if (!(await copyWithToast(code, label))) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={cn('relative min-w-0 max-w-full rounded-md border border-border bg-surface', className)}>
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-96 max-w-full overflow-auto p-3 pr-12 font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        <code>{code}</code>
      </pre>
      <Button type="button" variant="ghost" size="icon" className="absolute right-1.5 top-1.5" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}
