import { OverviewView } from '@/components/overview-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <OverviewView scope={{ kind: 'workspace', slug: decodeURIComponent(slug) }} />;
}
