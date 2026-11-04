'use client';

import Link from 'next/link';
import { scopeHref, type Scope, type Section } from '@/lib/scope';
import { useWorkspaces } from './workspaces-provider';

/** Global is always first and styled differently; it is not a Workspace. Links keep the current section. */
export function ScopeSwitcher({ active, section }: { active: Scope | null; section: Section }) {
  const { state, reload } = useWorkspaces();
  const globalActive = active?.kind === 'global';
  return (
    <nav aria-label="Scope" className="scope-switcher">
      <ul>
        <li>
          <Link
            href={scopeHref({ kind: 'global' }, section)}
            className="scope-link scope-global"
            aria-current={globalActive ? 'page' : undefined}
          >
            Global
          </Link>
        </li>
      </ul>
      <p className="scope-heading" id="workspaces-heading">
        Workspaces
      </p>
      {state.status === 'loading' && <p className="muted">Loading Workspaces…</p>}
      {state.status === 'error' && (
        <p role="alert" className="muted">
          Could not load Workspaces.{' '}
          <button type="button" className="link-button" onClick={reload}>
            Retry
          </button>
        </p>
      )}
      {state.status === 'ready' && (
        <ul aria-labelledby="workspaces-heading">
          {state.workspaces.map((w) => (
            <li key={w.id}>
              <Link
                href={scopeHref({ kind: 'workspace', slug: w.slug }, section)}
                className="scope-link"
                aria-current={active?.kind === 'workspace' && active.slug === w.slug ? 'page' : undefined}
              >
                {w.name}
              </Link>
            </li>
          ))}
          {state.workspaces.length === 0 && <li className="muted">No Workspaces yet</li>}
        </ul>
      )}
    </nav>
  );
}
