import { WorkspaceSettingsView } from '@/components/workspace-settings-view';

export default async function Page({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <WorkspaceSettingsView slug={decodeURIComponent(slug)} />;
}
