import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppShell } from '@/components/app-shell';
import { getSession } from '@/lib/session';

// Session state is per request and per user: never statically render or cache this layout.
export const dynamic = 'force-dynamic';

/** Every page in this route group is protected; new pages inherit the check by default. */
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  return (
    <AppShell username={session.username}>{children}</AppShell>
  );
}
