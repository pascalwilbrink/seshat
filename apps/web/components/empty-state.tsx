import * as React from 'react';
import { Inbox, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface EmptyStateProps extends Omit<React.ComponentProps<'div'>, 'title'> {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: LucideIcon;
  /** Usually a Button; rendered as given so the caller owns the callback. */
  action?: React.ReactNode;
}

export function EmptyState({ title, description, icon: Icon = Inbox, action, className, ...props }: EmptyStateProps) {
  return (
    <div className={cn('flex min-w-0 flex-col items-center gap-2 rounded-lg border border-dashed border-border p-8 text-center', className)} {...props}>
      <Icon aria-hidden="true" className="size-8 text-muted-foreground" />
      <p className="font-medium break-words">{title}</p>
      {description ? <p className="max-w-prose text-sm text-muted-foreground break-words">{description}</p> : null}
      {action ? <div className="mt-2 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}
