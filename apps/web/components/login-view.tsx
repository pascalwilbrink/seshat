'use client';

import { type FormEvent, useState } from 'react';
import { safeLocalPath } from '@/lib/safe-redirect';

export function LoginView({ next }: { next?: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFailed(false);
    try {
      // Plain fetch: a 401 here means wrong credentials, not an expired session.
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
      if (!res.ok) throw new Error('login failed');
      window.location.assign(safeLocalPath(next, '/'));
    } catch {
      setFailed(true);
      setPending(false);
    }
  }

  return (
    <main>
      <h1>Log in to Seshat</h1>
      <form onSubmit={onSubmit} aria-busy={pending}>
        <label htmlFor="username">Username</label>
        <input id="username" name="username" type="text" autoComplete="username" required disabled={pending} />
        <label htmlFor="password">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} />
        {failed && <p role="alert">Login failed. Check your username and password and try again.</p>}
        <button type="submit" disabled={pending}>
          {pending ? 'Logging in…' : 'Log in'}
        </button>
      </form>
    </main>
  );
}
