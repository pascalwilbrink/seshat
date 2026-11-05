import * as React from 'react';
import { Ban, CircleCheck, CircleX, Clock, History, Hourglass, LoaderCircle, type LucideIcon } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

export const STATUSES = ['pending', 'processing', 'indexed', 'failed', 'active', 'superseded', 'revoked', 'expired'] as const;
export type Status = (typeof STATUSES)[number];

const CONFIG: Record<Status, { label: string; variant: React.ComponentProps<typeof Badge>['variant']; icon: LucideIcon }> = {
  pending: { label: 'Pending', variant: 'secondary', icon: Clock },
  processing: { label: 'Processing', variant: 'info', icon: LoaderCircle },
  indexed: { label: 'Indexed', variant: 'success', icon: CircleCheck },
  failed: { label: 'Failed', variant: 'destructive', icon: CircleX },
  active: { label: 'Active', variant: 'success', icon: CircleCheck },
  superseded: { label: 'Superseded', variant: 'secondary', icon: History },
  revoked: { label: 'Revoked', variant: 'destructive', icon: Ban },
  expired: { label: 'Expired', variant: 'warning', icon: Hourglass },
};

/** Status as text plus icon plus colour, so colour is never the only signal. */
export function StatusBadge({ status, className, ...props }: { status: Status } & Omit<React.ComponentProps<typeof Badge>, 'variant' | 'children'>) {
  const { label, variant, icon: Icon } = CONFIG[status];
  return (
    <Badge variant={variant} data-status={status} className={cn('max-w-full', className)} {...props}>
      <Icon aria-hidden="true" className={cn('size-3 shrink-0', status === 'processing' && 'animate-spin motion-reduce:animate-none')} />
      <span className="truncate">{label}</span>
    </Badge>
  );
}
