import { McpView } from '@/components/mcp-view';
import { serverMcpEndpoint } from '@/lib/mcp-config';

// The endpoint comes from SESHAT_MCP_URL at request time, so one image works on any host.
export const dynamic = 'force-dynamic';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <McpView slug={decodeURIComponent(slug)} endpoint={serverMcpEndpoint()} />;
}
