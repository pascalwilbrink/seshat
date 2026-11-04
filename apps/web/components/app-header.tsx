'use client';

import { useState } from 'react';
import { apiFetch } from '@/lib/api-client';

export function AppHeader({ username }: { username: string }) {
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
    <header>
      <span>{username}</span>
      <button type="button" onClick={logout} disabled={pending}>
        {pending ? 'Logging out…' : 'Log out'}
      </button>
    </header>
  );
}
