'use client';

import Link from 'next/link';
import { Boxes, Check, ChevronsUpDown, Globe, Plus } from 'lucide-react';
import { areaFromPathname, switchScopeHref } from '@/lib/navigation';
import type { Scope } from '@/lib/scope';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { useWorkspaces } from './workspaces-provider';

export const CREATE_WORKSPACE_HREF = '/global/settings#create-workspace';

/** Bottom-of-sidebar scope dropdown. Global is first and distinct; Workspaces are sorted by name. */
export function ScopeSwitcher({ active, pathname, collapsed = false, onNavigate }: { active: Scope | null; pathname: string | null; collapsed?: boolean; onNavigate?: () => void }) {
  const { state, reload } = useWorkspaces();
  const area = areaFromPathname(pathname);
  const sorted = state.status === 'ready' ? [...state.workspaces].sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.slug.localeCompare(b.slug)) : [];
  const current = active?.kind === 'workspace' ? (sorted.find((w) => w.slug === active.slug)?.name ?? active.slug) : 'Global';
  const Icon = active?.kind === 'workspace' ? Boxes : Globe;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" aria-label={`Scope: ${current}. Switch scope`} className={cn('w-full justify-between', collapsed && 'justify-center px-0')}>
          <Icon aria-hidden="true" />
          {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{current}</span>}
          {!collapsed && <ChevronsUpDown aria-hidden="true" className="text-muted-foreground" />}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel>Scope</DropdownMenuLabel>
        <DropdownMenuItem asChild>
          <Link href={switchScopeHref({ kind: 'global' }, area)} data-scope-item="global" aria-current={active?.kind === 'global' ? 'page' : undefined} onClick={onNavigate}>
            <Globe aria-hidden="true" />
            <span className="flex-1">Global</span>
            {active?.kind === 'global' && <Check aria-hidden="true" />}
          </Link>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {state.status === 'loading' && (
          <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
            Loading Workspaces…
          </p>
        )}
        {state.status === 'error' && (
          <div role="alert" className="px-2 py-1.5 text-sm text-muted-foreground">
            <p>Could not load Workspaces.</p>
            <Button variant="link" size="sm" className="h-auto p-0" onClick={reload}>
              Retry
            </Button>
          </div>
        )}
        {state.status === 'ready' && sorted.length === 0 && <p className="px-2 py-1.5 text-sm text-muted-foreground">No Workspaces yet</p>}
        {sorted.map((w) => (
          <DropdownMenuItem asChild key={w.id}>
            <Link
              href={switchScopeHref({ kind: 'workspace', slug: w.slug }, area)}
              aria-current={active?.kind === 'workspace' && active.slug === w.slug ? 'page' : undefined}
              onClick={onNavigate}
            >
              <Boxes aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">{w.name}</span>
              {active?.kind === 'workspace' && active.slug === w.slug && <Check aria-hidden="true" />}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href={CREATE_WORKSPACE_HREF} onClick={onNavigate}>
            <Plus aria-hidden="true" />
            Create Workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
