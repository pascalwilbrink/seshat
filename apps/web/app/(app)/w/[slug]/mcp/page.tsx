import { McpView } from '@/components/mcp-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <McpView slug={decodeURIComponent(slug)} />;
}
