import * as React from 'react';
import type { LucideIcon } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export interface StatCardProps extends Omit<React.ComponentProps<typeof Card>, 'children'> {
  label: React.ReactNode;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Decorative: the label already names the metric. */
  icon?: LucideIcon;
}

export function StatCard({ label, value, hint, icon: Icon, className, ...props }: StatCardProps) {
  return (
    <Card className={cn('min-w-0 p-4', className)} {...props}>
      <div className="flex items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="min-w-0 break-words">{label}</span>
        {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0" /> : null}
      </div>
      <div className="mt-2 text-2xl font-semibold break-words">{value}</div>
      {hint ? <p className="mt-1 text-xs text-muted-foreground break-words">{hint}</p> : null}
    </Card>
  );
}
