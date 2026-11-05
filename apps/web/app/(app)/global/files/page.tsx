import { FilesView } from '@/components/files-view';
import { parseFileFocus } from '@/lib/search';

export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <FilesView scope={{ kind: 'global' }} focus={parseFileFocus(await searchParams)} />;
}
