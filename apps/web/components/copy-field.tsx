'use client';
import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Copies text; resolves true on success. Never logs the value. */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Runs the copy and reports the result as a toast. Returns whether it succeeded. */
export async function copyWithToast(value: string, label: string): Promise<boolean> {
  const ok = await copyText(value);
  if (ok) toast.success(`${label} copied`);
  else toast.error(`Couldn't copy ${label.toLowerCase()}. Select it and copy manually.`);
  return ok;
}

export interface CopyFieldProps {
  /** The value shown and copied. */
  value: string;
  /** Short sentence-case name, used in the button name and toasts, e.g. "Endpoint URL". */
  label: string;
  className?: string;
}

export function CopyField({ value, label, className }: CopyFieldProps) {
  const [copied, setCopied] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  React.useEffect(() => () => clearTimeout(timer.current), []);

  async function onCopy() {
    const ok = await copyWithToast(value, label);
    if (!ok) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-2 rounded-md border border-border bg-surface px-3 py-1.5', className)}>
      <code
        tabIndex={0}
        aria-label={label}
        className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring"
      >
        {value}
      </code>
      <Button type="button" variant="ghost" size="icon" className="shrink-0" onClick={onCopy} aria-label={`Copy ${label.toLowerCase()}`}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      </Button>
    </div>
  );
}
