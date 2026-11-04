import { LoginView } from '@/components/login-view';

export default async function Page({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  return <LoginView next={typeof next === 'string' ? next : undefined} />;
}
