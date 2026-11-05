import * as React from 'react';
import { Boxes, Globe } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Global and Workspace differ in icon, wording and colour. */
export function ScopeBadge({ scope, className, ...props }: { scope: 'global' | 'workspace' } & Omit<React.ComponentProps<typeof Badge>, 'variant' | 'children'>) {
  const global = scope === 'global';
  const Icon = global ? Globe : Boxes;
  return (
    <Badge variant={global ? 'default' : 'outline'} data-scope={scope} className={cn('max-w-full', className)} {...props}>
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{global ? 'Global' : 'Workspace'}</span>
    </Badge>
  );
}
