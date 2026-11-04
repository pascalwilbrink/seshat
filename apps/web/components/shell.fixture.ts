import type { WorkspaceDto } from '@/lib/api-types';

export const ws = (slug: string, name = slug.toUpperCase(), id = `id-${slug}`): WorkspaceDto => ({
  id,
  name,
  slug,
  description: `About ${slug}`,
  createdAt: '2026-03-02T10:00:00.000Z',
  updatedAt: '2026-03-02T10:00:00.000Z',
});

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Routes fetch by URL; unmatched URLs fail the test. */
export function routeFetch(routes: Record<string, () => Response | Promise<Response>>) {
  return (url: string) => {
    const handler = routes[url];
    if (!handler) throw new Error(`Unexpected fetch ${url}`);
    return Promise.resolve(handler());
  };
}
