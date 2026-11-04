import { redirect } from 'next/navigation';
import { GLOBAL_OVERVIEW_PATH } from '@/lib/scope';

export default function Page() {
  redirect(GLOBAL_OVERVIEW_PATH);
}
