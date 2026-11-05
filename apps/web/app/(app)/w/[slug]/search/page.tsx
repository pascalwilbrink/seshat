import { SearchView } from '@/components/search-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <SearchView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} />;
}
