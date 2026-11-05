import { FilesView } from '@/components/files-view';
import { parseFileFocus } from '@/lib/search';

export default async function Page({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { slug } = await params;
  return <FilesView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} focus={parseFileFocus(await searchParams)} />;
}
