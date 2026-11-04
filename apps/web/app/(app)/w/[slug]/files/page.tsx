import { FilesView } from '@/components/files-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <FilesView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} />;
}
