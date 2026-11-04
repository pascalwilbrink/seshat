import { ApiKeysView } from '@/components/api-keys-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <ApiKeysView slug={decodeURIComponent(slug)} />;
}
