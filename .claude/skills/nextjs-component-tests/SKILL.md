---
name: nextjs-component-tests
description: "Use when writing or changing tests for Next.js App Router client components or views with vitest (or jest), jsdom and Testing Library: next/navigation mocks, async/polling views, fixture builders, role-based queries, nested clickable elements, jest-dom typings and running installs first."
managed-by: gildeboek@2d32bfd
---

# Testing Next.js components with Testing Library

Specs sit next to the component (`*.spec.tsx`), test data in `*.fixture.ts`. Examples use vitest; with jest replace `vi` by `jest`.

## 1. Mock `next/navigation`

`useRouter`, `usePathname` and `useSearchParams` throw or return nothing outside the App Router. Mock them in every spec whose component uses them, also when it only does so through a hook (e.g. a `useProject` hook).

```tsx
let search = new URLSearchParams();
const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: push, refresh: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => search,
}));

beforeEach(() => {
  search = new URLSearchParams();
  push.mockClear();
});
// in a test: search = new URLSearchParams('project=p1'); render(<View />);
```

Set `search` before `render`; it is read when the component renders.

## 2. Await the final element, assert every state

Views that poll or load render a wrapper (header, skeleton) immediately. Waiting for that proves nothing. Await the element only the loaded state shows.

```tsx
render(<Dashboard />);
expect(screen.getByTestId('skeleton')).toBeInTheDocument(); // loading, explicit
expect(await screen.findByRole('heading', { name: 'Fix login' })).toBeInTheDocument();
```

Test loading, error (rejected fetch shows the message) and empty (no items shows the empty state) as separate cases, not only the happy path. Use `waitFor` for non-element assertions (a mock having been called). With fake timers for polling, advance them inside `act`.

## 3. Fixture builders: derive after overrides

```ts
export function buildList(overrides: Partial<List> = {}): List {
  const items = overrides.items ?? [buildItem()];
  return { items, total: items.length, label: `${items.length} items`, ...overrides };
}
```

Compute totals, counts and labels from the final values (`items` above), then spread the overrides last only for fields that are not derived. Computing them before applying overrides makes `buildList({ items: [] })` silently return `total: 1`.

## 4. Query by role and accessible name

```tsx
await user.click(screen.getByRole('button', { name: 'Queue job' }));
expect(screen.getByRole('link', { name: /pull request/i })).toHaveAttribute('href', url);
```

Prefer `getByRole` with `name`, then `getByLabelText`, then `getByText`. Avoid class names and `data-testid`; use a test id only for something with no role or text (e.g. a skeleton). If a role query fails, the component's accessibility is probably wrong: fix that, not the query.

## 5. Interactive elements inside clickable cards

A card that opens on click must not open when its nested link, checkbox or button is used.

```tsx
const onOpen = vi.fn();
render(<JobCard job={buildJob()} onOpen={onOpen} />);
await user.click(screen.getByRole('link', { name: /#42/ }));
expect(onOpen).not.toHaveBeenCalled();
await user.click(screen.getByRole('article')); // the card itself still opens
expect(onOpen).toHaveBeenCalledTimes(1);
```

Cover each nested element type, and keyboard (Enter/Space) if the card handles it.

## 6. jest-dom typings

Matchers like `toBeInTheDocument` need runtime and type setup: import `@testing-library/jest-dom/vitest` (jest: `@testing-library/jest-dom`) in the setup file, and include that file or the package types in `tsconfig.json` (`"types": ["vitest/globals", "@testing-library/jest-dom"]`). If plain `tsc` already reports matcher errors in existing specs, don't "fix" unrelated specs: rely on the build and the test runner, and make sure your own spec runs green.

## 7. Install first

In a fresh checkout run the install command (`pnpm install`, `npm ci`, or what AGENTS.md says) before any test; component tests fail to start without dependencies and the error looks like a config problem.
