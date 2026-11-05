import * as React from 'react';
import { TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ErrorStateProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  title?: React.ReactNode;
  /** A message that is already safe to show; never pass raw errors or server details. */
  message?: React.ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}

export function ErrorState({ title = 'Something went wrong', message = 'Try again in a moment.', onRetry, retryLabel = 'Try again', className, ...props }: ErrorStateProps) {
  return (
    <div role="alert" className={cn('flex min-w-0 flex-col items-center gap-2 rounded-lg border border-destructive p-8 text-center', className)} {...props}>
      <TriangleAlert aria-hidden="true" className="size-8 text-destructive" />
      <p className="font-medium break-words">{title}</p>
      <p className="max-w-prose text-sm text-muted-foreground break-words">{message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" className="mt-2" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
