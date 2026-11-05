import { MemoriesView } from '@/components/memories-view';
import { parseMemoryFocus } from '@/lib/search';

export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  return <MemoriesView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} focusMemoryId={parseMemoryFocus(await searchParams)} />;
}
