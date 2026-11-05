export const SIDEBAR_STORAGE_KEY = 'seshat.sidebar.collapsed';

/** Storage can throw (private mode, blocked site data) or be missing; the sidebar then simply stays expanded. */
export function readSidebarCollapsed(): boolean {
  try {
    return window.localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Not persisted; the in-memory state still works.
  }
}
