import { CollectionsView } from '@/components/collections-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <CollectionsView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} />;
}
