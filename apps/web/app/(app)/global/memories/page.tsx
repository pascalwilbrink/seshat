import { MemoriesView } from '@/components/memories-view';

export default function Page() {
  return <MemoriesView scope={{ kind: 'global' }} />;
}
