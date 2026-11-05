'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, LogOut, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { toast } from 'sonner';
import { apiFetch } from '@/lib/api-client';
import { areaFromPathname, areaHref, visibleGroups } from '@/lib/navigation';
import { scopeFromPathname, type Scope } from '@/lib/scope';
import { readSidebarCollapsed, writeSidebarCollapsed } from '@/lib/sidebar-storage';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { FlashToast } from './flash-toast';
import { ScopeBadge } from './scope-badge';
import { ScopeSwitcher } from './scope-switcher';
import { WorkspacesProvider, useWorkspaces } from './workspaces-provider';

function Wordmark({ collapsed }: { collapsed?: boolean }) {
  return (
    <p className={cn('flex h-10 items-center px-2 text-base font-semibold tracking-tight', collapsed && 'justify-center px-0')}>
      <span aria-hidden="true" className="text-primary">
        ◆
      </span>
      <span className={cn('ml-2', collapsed && 'sr-only')}>Seshat</span>
    </p>
  );
}

function Navigation({ scope, pathname, collapsed, onNavigate }: { scope: Scope; pathname: string | null; collapsed: boolean; onNavigate?: () => void }) {
  const current = areaFromPathname(pathname);
  const groups = visibleGroups(scope);
  return (
    <nav aria-label="Sections" className="flex flex-col gap-4">
      {groups.map(({ group, areas }) => (
        <div key={group.id} className="flex flex-col gap-1">
          <p className={cn('px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground', collapsed && 'sr-only')}>{group.label}</p>
          <ul className="flex flex-col gap-1">
            {areas.map((area) => {
              const Icon = area.icon;
              const link = (
                <Link
                  href={areaHref(scope, area)}
                  onClick={onNavigate}
                  aria-current={current?.id === area.id ? 'page' : undefined}
                  aria-label={collapsed ? area.label : undefined}
                  className={cn(
                    'flex h-9 items-center gap-2 rounded-md px-2 text-sm text-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium',
                    collapsed && 'justify-center px-0',
                  )}
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {!collapsed && <span className="truncate">{area.label}</span>}
                </Link>
              );
              return (
                <li key={area.id}>
                  {collapsed ? (
                    <Tooltip>
                      <TooltipTrigger asChild>{link}</TooltipTrigger>
                      <TooltipContent side="right">{area.label}</TooltipContent>
                    </Tooltip>
                  ) : (
                    link
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function UserMenu({ username, collapsed }: { username: string; collapsed: boolean }) {
  const [pending, setPending] = useState(false);

  async function signOut() {
    if (pending) return;
    setPending(true);
    try {
      const res = await apiFetch('/api/auth/logout', { method: 'POST' });
      if (res.ok) toast.success('Signed out');
      else toast.error('Sign-out may not have completed. Sign in again if needed.');
    } catch {
      toast.error('Sign-out may not have completed. Sign in again if needed.');
    }
    // Navigate regardless; the server validates the session on the next page load.
    window.location.assign('/login');
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label={`Account menu for ${username}`} className={cn('w-full justify-start', collapsed && 'justify-center px-0')}>
          <span aria-hidden="true" className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {username.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && <span className="min-w-0 truncate">{username}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="truncate">{username}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={pending}
          onSelect={(e) => {
            e.preventDefault();
            void signOut();
          }}
        >
          <LogOut aria-hidden="true" />
          {pending ? 'Signing out…' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SidebarBody({ scope, active, pathname, username, collapsed, onNavigate }: { scope: Scope; active: Scope | null; pathname: string | null; username: string; collapsed: boolean; onNavigate?: () => void }) {
  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <Wordmark collapsed={collapsed} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Navigation scope={scope} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />
      </div>
      <div className="flex flex-col gap-1 border-t border-border pt-3">
        <ScopeSwitcher active={active} pathname={pathname} collapsed={collapsed} onNavigate={onNavigate} />
        <UserMenu username={username} collapsed={collapsed} />
      </div>
    </div>
  );
}

/** Scope + area breadcrumb with the badge that distinguishes Global from a Workspace. Rendered on every scoped page. */
function ScopeHeader({ active, pathname }: { active: Scope | null; pathname: string | null }) {
  const { state } = useWorkspaces();
  if (!active) return null;
  const area = areaFromPathname(pathname);
  const name = active.kind === 'global' ? 'Global' : (state.workspaces?.find((w) => w.slug === active.slug)?.name ?? active.slug);
  return (
    <div className="flex min-w-0 items-center gap-2">
      <nav aria-label="Breadcrumb" className="min-w-0">
        <ol className="flex min-w-0 items-center gap-1 text-sm">
          <li className="min-w-0 truncate text-muted-foreground">{name}</li>
          {area && (
            <>
              <li aria-hidden="true">
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </li>
              <li aria-current="page" className="truncate font-medium">
                {area.label}
              </li>
            </>
          )}
        </ol>
      </nav>
      <ScopeBadge scope={active.kind} />
    </div>
  );
}

export function AppShell({ username, children }: { username: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = scopeFromPathname(pathname);
  const navScope: Scope = active ?? { kind: 'global' };
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Read after mount so server and first client render match; storage failures leave it expanded.
  useEffect(() => setCollapsed(readSidebarCollapsed()), []);
  useEffect(() => setSheetOpen(false), [pathname]);

  function toggle() {
    setCollapsed((c) => {
      writeSidebarCollapsed(!c);
      return !c;
    });
  }

  return (
    <WorkspacesProvider>
      <FlashToast />
      <TooltipProvider delayDuration={200}>
        <div className="flex min-h-screen">
          <a
            href="#main"
            className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:outline-2 focus:outline-ring"
          >
            Skip to content
          </a>
          <aside
            aria-label="Sidebar"
            data-collapsed={collapsed}
            className={cn('sticky top-0 hidden h-screen shrink-0 border-r border-border bg-surface p-3 md:block', collapsed ? 'w-16' : 'w-60')}
          >
            <SidebarBody scope={navScope} active={active} pathname={pathname} username={username} collapsed={collapsed} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            <header className="flex h-14 items-center gap-2 border-b border-border px-4">
              <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open navigation">
                    <Menu aria-hidden="true" />
                  </Button>
                </SheetTrigger>
                <SheetContent side="left">
                  <SheetTitle className="sr-only">Navigation</SheetTitle>
                  <SheetDescription className="sr-only">Sections, scope and account</SheetDescription>
                  <SidebarBody scope={navScope} active={active} pathname={pathname} username={username} collapsed={false} onNavigate={() => setSheetOpen(false)} />
                </SheetContent>
              </Sheet>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:inline-flex"
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-expanded={!collapsed}
                onClick={toggle}
              >
                {collapsed ? <PanelLeftOpen aria-hidden="true" /> : <PanelLeftClose aria-hidden="true" />}
              </Button>
              <ScopeHeader active={active} pathname={pathname} />
            </header>
            <main id="main" tabIndex={-1} className="min-w-0 flex-1 p-4 md:p-6">
              {children}
            </main>
          </div>
        </div>
      </TooltipProvider>
    </WorkspacesProvider>
  );
}
