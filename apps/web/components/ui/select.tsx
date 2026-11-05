import * as React from 'react';
import { cn } from '@/lib/utils';

/** Native select styled with the same tokens as Input. */
export function Select({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'h-9 w-full min-w-0 rounded-md border border-input bg-surface px-3 text-sm text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive',
        className,
      )}
      {...props}
    />
  );
}
