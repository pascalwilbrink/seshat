'use client';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What will happen, in plain words. */
  consequence: string;
  /** When set, the user must type exactly this value before the action is enabled. */
  confirmSlug?: string;
  confirmLabel: string;
  cancelLabel?: string;
  /** Called once per click while not pending. May return a promise. */
  onConfirm: () => void | Promise<void>;
  /** Caller-owned pending state (request in flight). */
  pending?: boolean;
  /** Safe, actionable failure message shown inline; the dialog stays open for retry. */
  error?: string | null;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  consequence,
  confirmSlug,
  confirmLabel,
  cancelLabel = 'Cancel',
  onConfirm,
  pending = false,
  error = null,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState('');
  const inFlight = React.useRef(false);
  const inputId = React.useId();
  const errorId = React.useId();

  // Radix only restores focus to a Dialog.Trigger; callers open this from their own buttons,
  // so remember the opener and focus it again when the dialog closes.
  const opener = React.useRef<HTMLElement | null>(null);
  if (open && opener.current === null && typeof document !== 'undefined') {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }

  React.useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const busy = pending;
  const matches = confirmSlug === undefined || typed === confirmSlug;

  async function submit() {
    if (!matches || busy || inFlight.current) return;
    inFlight.current = true;
    try {
      await onConfirm();
    } finally {
      inFlight.current = false;
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (busy && !next ? undefined : onOpenChange(next))}>
      <DialogContent
        onCloseAutoFocus={(event) => {
          const target = opener.current;
          opener.current = null;
          if (target && target.isConnected) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{consequence}</DialogDescription>
          </DialogHeader>
          {confirmSlug !== undefined && (
            <div className="grid gap-1.5">
              <Label htmlFor={inputId}>
                Type <span className="font-mono">{confirmSlug}</span> to confirm
              </Label>
              <Input
                id={inputId}
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                disabled={busy}
                className="font-mono"
                aria-describedby={error ? errorId : undefined}
              />
            </div>
          )}
          {error && (
            <p id={errorId} role="alert" className="break-words text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              {cancelLabel}
            </Button>
            <Button type="submit" variant="destructive" disabled={!matches || busy} aria-busy={busy}>
              {busy ? 'Working…' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
