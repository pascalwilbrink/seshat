import { MemoriesView } from '@/components/memories-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <MemoriesView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} />;
}
