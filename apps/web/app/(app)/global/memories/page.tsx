import { MemoriesView } from '@/components/memories-view';
import { parseMemoryFocus } from '@/lib/search';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MemoriesView scope={{ kind: 'global' }} focusMemoryId={parseMemoryFocus(await searchParams)} />;
}
