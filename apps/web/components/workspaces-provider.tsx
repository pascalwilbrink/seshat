'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { apiFetch } from '@/lib/api-client';
import type { WorkspaceDto } from '@/lib/api-types';

export type WorkspacesState =
  | { status: 'loading'; workspaces: null }
  | { status: 'error'; workspaces: null }
  | { status: 'ready'; workspaces: WorkspaceDto[] };

interface Ctx {
  state: WorkspacesState;
  reload: () => void;
  /** Re-fetches the collection without a loading flash and resolves once the new data is in place. */
  refresh: () => Promise<void>;
}

const WorkspacesContext = createContext<Ctx | null>(null);

/** Loads the authorized Workspace collection once for the shell; the switcher and slug resolution share it. */
export function WorkspacesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<WorkspacesState>({ status: 'loading', workspaces: null });
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => {
    setState({ status: 'loading', workspaces: null });
    setTick((t) => t + 1);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await apiFetch('/api/global/workspaces');
      if (!res.ok) throw new Error('failed');
      setState({ status: 'ready', workspaces: (await res.json()) as WorkspaceDto[] });
    } catch {
      setState({ status: 'error', workspaces: null });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch('/api/global/workspaces');
        if (!res.ok) throw new Error('failed');
        const data = (await res.json()) as WorkspaceDto[];
        if (!cancelled) setState({ status: 'ready', workspaces: data });
      } catch {
        if (!cancelled) setState({ status: 'error', workspaces: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const value = useMemo(() => ({ state, reload, refresh }), [state, reload, refresh]);
  return <WorkspacesContext.Provider value={value}>{children}</WorkspacesContext.Provider>;
}

export function useWorkspaces(): Ctx {
  const ctx = useContext(WorkspacesContext);
  if (!ctx) throw new Error('useWorkspaces must be used inside WorkspacesProvider');
  return ctx;
}
