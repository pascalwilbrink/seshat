import type { ReactNode } from 'react';
import { Label } from '@/components/ui/label';

/** Label + control with an accessible error: the control gets aria-invalid and aria-describedby. */
export function FormField({
  id,
  label,
  error,
  hint,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => ReactNode;
}) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {hint && (
        <p id={hintId} className="text-sm text-muted-foreground break-words">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-sm text-destructive break-words">
          {error}
        </p>
      )}
    </div>
  );
}
