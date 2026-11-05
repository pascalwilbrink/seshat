'use client';

import { type FormEvent, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { queueFlash } from '@/lib/flash';
import { safeLocalPath } from '@/lib/safe-redirect';

/** Centred, unscoped login panel. It lives outside the protected shell, so it has no sidebar or scope. */
export function LoginView({ next }: { next?: string }) {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setFailed(false);
    let res: Response;
    try {
      // Plain fetch: a 401 here means wrong credentials, not an expired session.
      res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ username: data.get('username'), password: data.get('password') }),
      });
    } catch {
      setFailed(true);
      setPending(false);
      toast.error('Could not reach Seshat. Try again.');
      return;
    }
    if (!res.ok) {
      setFailed(true);
      setPending(false);
      toast.error('Login failed. Check your username and password.');
      return;
    }
    // The page is replaced by a full navigation, so the success toast is shown by the shell after it loads.
    queueFlash('Signed in');
    window.location.assign(safeLocalPath(next, '/'));
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm min-w-0">
        <CardHeader>
          <p className="flex items-center text-base font-semibold tracking-tight">
            <span aria-hidden="true" className="mr-2 text-primary">
              ◆
            </span>
            Seshat
          </p>
          <CardTitle as="h1" className="text-xl">Log in to Seshat</CardTitle>
          <CardDescription>Use the admin credentials for this instance.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} aria-busy={pending} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="username">Username</Label>
              <Input id="username" name="username" type="text" autoComplete="username" required disabled={pending} aria-invalid={failed || undefined} />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="password">Password</Label>
              <Input id="password" name="password" type="password" autoComplete="current-password" required disabled={pending} aria-invalid={failed || undefined} />
            </div>
            {failed && (
              <p role="alert" className="text-sm text-destructive">
                Login failed. Check your username and password and try again.
              </p>
            )}
            <Button type="submit" disabled={pending} className="w-full">
              {pending ? 'Logging in…' : 'Log in'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
