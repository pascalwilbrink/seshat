import type { ReactNode } from 'react';
import { redirect } from 'next/navigation';
import { AppHeader } from '@/components/app-header';
import { getSession } from '@/lib/session';

// Session state is per request and per user: never statically render or cache this layout.
export const dynamic = 'force-dynamic';

/** Every page in this route group is protected; new pages inherit the check by default. */
export default async function ProtectedLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/login');
  return (
    <>
      <AppHeader username={session.username} />
      {children}
    </>
  );
}
