'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api-client';
import { WORKSPACE_ONLY_SECTIONS, scopeFromPathname, scopeHref, sectionFromPathname, type Scope, type Section } from '@/lib/scope';
import { ScopeSwitcher } from './scope-switcher';
import { WorkspacesProvider } from './workspaces-provider';

const SECTIONS: { section: Section; label: string }[] = [
  { section: 'overview', label: 'Overview' },
  { section: 'api-keys', label: 'API Keys' },
  { section: 'settings', label: 'Settings' },
];

export function AppShell({ username, children }: { username: string; children: ReactNode }) {
  const pathname = usePathname();
  const active = scopeFromPathname(pathname);
  const section = sectionFromPathname(pathname);
  const navScope: Scope = active ?? { kind: 'global' };
  const [pending, setPending] = useState(false);

  async function logout() {
    setPending(true);
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Navigate to login regardless; the server validates the session on the next page load.
    }
    window.location.assign('/login');
  }

  return (
    <WorkspacesProvider>
      <div className="shell">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <aside className="shell-side">
          <p className="brand">Seshat</p>
          <ScopeSwitcher active={active} section={section} />
          <nav aria-label="Sections">
            <ul>
              {SECTIONS.filter((s) => navScope.kind === 'workspace' || !WORKSPACE_ONLY_SECTIONS.includes(s.section)).map((s) => (
                <li key={s.section}>
                  <Link
                    href={scopeHref(navScope, s.section)}
                    className="scope-link"
                    aria-current={section === s.section ? 'page' : undefined}
                  >
                    {s.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="shell-user">
            <span className="muted">{username}</span>
            <button type="button" className="link-button" onClick={logout} disabled={pending}>
              {pending ? 'Logging out…' : 'Log out'}
            </button>
          </div>
        </aside>
        <main id="main" className="shell-main">
          {children}
        </main>
      </div>
    </WorkspacesProvider>
  );
}
