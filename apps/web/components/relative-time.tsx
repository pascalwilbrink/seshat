'use client';
import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60],
];

/** Exact, timezone-independent text (UTC) so server and client render the same. */
export function formatExact(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')} UTC`;
}

export function formatRelative(date: Date, now: Date): string {
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(seconds);
  const fmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 45) return seconds <= 0 ? 'just now' : 'in a few seconds';
  for (const [unit, size] of UNITS) {
    if (abs >= size) return fmt.format(Math.trunc(seconds / size), unit);
  }
  return fmt.format(Math.trunc(seconds / 60), 'minute');
}

export interface RelativeTimeProps extends Omit<React.ComponentProps<'time'>, 'dateTime' | 'children'> {
  value: string | number | Date;
  /** Fixed clock for tests and snapshots. Without it, the relative text appears after mount. */
  now?: string | number | Date;
}

export function RelativeTime({ value, now, className, ...props }: RelativeTimeProps) {
  const date = new Date(value);
  const [mountedNow, setMountedNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    if (now === undefined) setMountedNow(new Date());
  }, [now]);

  if (Number.isNaN(date.getTime())) return <span className={className}>Unknown time</span>;
  const exact = formatExact(date);
  const clock = now !== undefined ? new Date(now) : mountedNow;
  // Before mount (server render and first client render) show the exact text: no mismatch.
  const text = clock ? formatRelative(date, clock) : exact;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time dateTime={date.toISOString()} tabIndex={0} className={cn('rounded-sm', className)} {...props}>
            {text}
          </time>
        </TooltipTrigger>
        <TooltipContent>{exact}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
