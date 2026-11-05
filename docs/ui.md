# Seshat UI guide

This guide is **binding for all UI work** in `apps/web`. It comes from the approved spec
[`seshat-ui-design-system-shell`](specs/seshat-ui-design-system-shell.md) and describes what is
in the repository today. If code and this guide disagree, fix one of them in the same change.
`pnpm --filter @seshat/web test` runs `docs-ui.spec.ts`, which checks the token names, file
paths, component exports and navigation ids named here.

Do not add a second design system, hand-written component CSS, raw colours or duplicate
components. Read the bundled Next.js docs in `node_modules/next/dist/docs/` before changing
framework config (see `apps/web/AGENTS.md`).

## Stack

- Tailwind CSS 4 (CSS-first, `@import 'tailwindcss'` in `apps/web/app/globals.css`, no `tailwind.config`).
- shadcn/ui primitives owned by the repo in `apps/web/components/ui` (config: `apps/web/components.json`, alias `@/components/ui`).
- `lucide-react` for icons, `sonner` for toasts, Geist Sans and Geist Mono from the `geist` package.
- Merge classes with `cn` from `@/lib/utils`. Import with the `@/` alias.
- The product is **dark only**. There is no light theme and no theme switch. Tokens are semantic so a light set can be added later by redefining the same names.

## Tokens

All colours are CSS variables on `:root` in `apps/web/app/globals.css`, exposed to Tailwind through `@theme inline` as `--color-<name>`. Use the Tailwind utilities (`bg-background`, `text-muted-foreground`, `border-border`, …). **Never** use a raw colour (`#hex`, `rgb()`, `text-white`, `bg-zinc-900`, …) in components, pages or `lib/`.

| Token | Value | Use |
| --- | --- | --- |
| `background` / `foreground` | `#0B0B10` / `#F4F4F5` | Page and default text |
| `surface` (`card`) / `surface-foreground` | `#121219` / `#F4F4F5` | Sidebar, cards, code blocks |
| `popover` / `popover-foreground` | `#16161F` / `#F4F4F5` | Menus, dialogs, sheets, toasts |
| `muted` / `muted-foreground` | `#1B1B25` / `#A1A1AA` | Quiet fills, secondary text |
| `border` | `#26262F` | Separators and card borders |
| `input` | `#63636E` | Form control borders (3:1 against the background) |
| `primary` / `primary-foreground` | `#8B5CF6` / `#0B0B10` | Primary action, active navigation, Global badge |
| `accent` / `accent-foreground` | `#1F1F2B` / `#F4F4F5` | Hover and selected fills |
| `destructive` / `destructive-foreground` | `#F87171` / `#0B0B10` | Errors, delete |
| `success`, `warning`, `info` + `-foreground` | green, amber, sky / `#0B0B10` | Statuses |
| `ring` | `#8B5CF6` | Focus outline |

Radius: `--radius` is `0.5rem`; use `rounded-sm` (4 px), `rounded-md` (6 px), `rounded-lg` (8 px), `rounded-xl` (12 px). Badges use `rounded-full`.

### Contrast-safe pairings

Only these pairings are verified by `apps/web/app/globals.css.spec.ts` (WCAG AA, 4.5:1 for text, 3:1 for the control border and focus ring):

- `foreground` on `background` and `surface`; `muted-foreground` on `background`, `surface` and `muted`; `popover-foreground` on `popover`.
- Each `*-foreground` on its own fill: `primary`, `destructive`, `success`, `warning`, `info`, `accent`.
- `primary` text on `background` only (it is 4.4:1 on `surface`, so links inside cards, tables and other surfaces use `text-foreground underline`), and `destructive` text on `surface`.
- `input` and `ring` against `background` (3:1).

Do not put `muted-foreground` text on `primary`, and do not invent a new pairing (for example `success` text on `muted`) without adding it to the spec first. After changing a token, rerun the spec.

## Typography

- Geist Sans is `font-sans` (the body default). Geist Mono is `font-mono`.
- Use **mono** for ids, slugs, API key prefixes and secrets, hashes, URLs the user copies, file paths and code. Everything else is sans.
- Scale: page title `text-2xl font-semibold` (`PageHeader`), section heading `text-lg font-semibold`, body `text-sm` or `text-base`, metadata `text-sm text-muted-foreground`, labels and badges `text-xs`. No other display sizes.
- Long names and ids wrap (`break-words`) or truncate (`truncate`) with the full text available elsewhere (tooltip or detail); they must never widen the page.

## Spacing and layout

- Use the Tailwind 4 px scale. Page content padding is `p-4 md:p-6` (set by the shell); vertical rhythm inside a page is `gap-4` or `gap-6`; related controls `gap-2`.
- Pages render only their own content inside the shell's `<main>`; never add a second `<main>`, sidebar or page-level scroll container.
- Avoid nested cards and decorative gradients. Prefer a border (`border border-border`) or whitespace to group content.
- Every flex or grid child that holds text needs `min-w-0`. Wide content (tables, code) scrolls inside its own container, never the page. **Do not** hide overflow on `html` or `body` to cure a layout bug.

## App shell and navigation

The shell is `components/app-shell.tsx` (rendered by `app/(app)/layout.tsx`): collapsible sidebar (full width with labels or icon-only with tooltips, stored per browser under `SIDEBAR_STORAGE_KEY` in `lib/sidebar-storage.ts`), the groups Knowledge, Developer and System, the scope selector (`components/scope-switcher.tsx`) and the user menu at the bottom, and a sheet opened from a header button below 768 px (`md`). Every scoped page shows a breadcrumb (`Global / Overview`, `<workspace name> / Settings`) with a `ScopeBadge`.

Navigation is declared once in `apps/web/lib/navigation.ts`:

```ts
export interface NavArea {
  id: string;
  label: string;
  group: 'knowledge' | 'developer' | 'system';
  icon: LucideIcon;
  route: string; // below the scope: /global/<route> and /w/<slug>/<route>
  scopes: readonly ('global' | 'workspace')[];
  available: boolean; // only available areas are listed
}
```

`NAV_AREAS` lists every area, `NAV_GROUPS` the three groups, and `visibleGroups(scope)` filters to available areas that apply to the scope. `switchScopeHref` keeps the current area when switching scope if it exists and is available there, otherwise it goes to Overview. The scope selector lists Global first (globe icon), then Workspaces alphabetically, then "Create Workspace" (`CREATE_WORKSPACE_HREF`).

### Adding or enabling an area

An area needs **only a config entry and its route**. The entry already exists for every planned area. The ids are `overview`, `files`, `collections`, `search`, `memories`, `api-keys`, `mcp` and `settings`.

1. Create the route(s) `app/(app)/global/<route>/page.tsx` and/or `app/(app)/w/[slug]/<route>/page.tsx` (only for the scopes in `scopes`). Pages stay thin and render one view from `components/`.
2. Set `available: true` on the entry in `NAV_AREAS`. Add a new entry only for a genuinely new area.
3. Add or update the tests in `lib/navigation.spec.ts` and the feature's own view tests.

Do not touch `app-shell.tsx` for this.

### Current availability

Currently **Overview**, **Memories** and **Settings** are available (listed in the navigation). Files, Collections and API Keys already exist as direct routes (`/global/files`, `/w/<slug>/files`, `/global/collections`, `/w/<slug>/collections`, `/w/<slug>/api-keys`). Those routes and their behaviour are preserved; they are simply not listed in the sidebar until their feature work marks the area `available`. Search and MCP have no routes yet. Memories (`/global/memories`, `/w/<slug>/memories`) is read-only for now: filtered newest-first list, load-more and a detail with successor navigation. Do not expose a route in the navigation before its page follows this guide.

## Shared components

Import from `@/components/<file>` (named exports). Use a shared component whenever one fits; add a new one only when none does, with a test and an entry here.

| Component | Import | Use when |
| --- | --- | --- |
| `PageHeader` | `@/components/page-header` | Top of every page: `title`, optional `description`, optional `actions` (buttons). Renders the page `<h1>`. |
| `StatCard` | `@/components/stat-card` | One metric: `label`, `value`, optional `hint`, optional decorative `icon` (a `LucideIcon`). Only show stats the API provides. |
| `DataTable<T>` | `@/components/data-table` | Any list of records. Props: `columns` (`DataTableColumn<T>`: `id`, `header`, `cell`, `sortable`, `className`), `rows`, `getRowId`, `label`; controlled `sort`/`onSortChange`, `selectedIds`/`onSelectedIdsChange`, `getRowLabel`, `bulkActions`; `loading` + `skeletonRows`, `empty`, `hasMore`/`onLoadMore`/`loadingMore`. The caller owns sorting, filtering and cursor paging. |
| `EmptyState` | `@/components/empty-state` | Nothing to show yet: `title`, `description`, `icon`, `action` (a `Button`). |
| `ErrorState` | `@/components/error-state` | A load failed: safe `message`, `onRetry`, `retryLabel`. Has `role="alert"`. |
| `StatusBadge` | `@/components/status-badge` | A status: `status` is one of `STATUSES` (`pending`, `processing`, `indexed`, `failed`, `active`, `superseded`, `revoked`, `expired`). Text + icon + colour; `processing` spins (reduced-motion safe). |
| `FileTypeIcon` | `@/components/file-type-icon` | File type next to a name: `name`, `mimeType`, `labelled`. `fileKind()` classifies. Decorative unless `labelled`. |
| `ScopeBadge` | `@/components/scope-badge` | Marks Global versus Workspace: `scope="global" | "workspace"`. |
| `CopyField` | `@/components/copy-field` | A short value the user copies (endpoint, one-time secret): `value`, `label`. Monospace, copy button, "copied" toast. `copyWithToast` is reusable. |
| `ConfirmDialog` | `@/components/confirm-dialog` | Destructive or irreversible action: `open`, `onOpenChange`, `title`, `consequence`, `confirmLabel`, optional `confirmSlug` (type to confirm), `onConfirm`, `pending`, `error`. Restores focus to the opener. |
| `CodeSnippet` | `@/components/code-snippet` | Multi-line code or configuration: `code`, `label`. Monospace block with copy; long lines scroll inside the block. |
| `RelativeTime` | `@/components/relative-time` | Any timestamp: `value`, optional `now` (tests). Relative text, exact UTC time on hover and focus. |

Related building blocks: `FormField` (`@/components/form-field`: `id`, `label`, `hint`, `error`, render-prop child that receives `id`, `aria-invalid`, `aria-describedby`), and the shadcn primitives in `components/ui` (`Button`, `Badge`, `Card`, `Checkbox`, `Dialog`, `DropdownMenu`, `Input`, `Label`, `Sheet`, `Skeleton`, `Table`, `Textarea`, `Tooltip`). Buttons: variants `default` (one primary action per area), `outline`, `secondary`, `ghost`, `destructive`, `link`; sizes `default`, `sm`, `lg`, `icon`.

Some older views (`FormField`, the settings views, the Files, Collections and API Keys views) may still use legacy class names from `globals.css`. Do not copy those; the cleanup work replaces them with token utilities. New code never adds a hand-written class.

### Toasts

The toaster is mounted **once**, in `app/layout.tsx` (`Toaster` from `@/components/ui/sonner`). Never mount it in a page or component. Fire toasts with `toast.success(...)` / `toast.error(...)` from `sonner`.

## Required page states

Every page or data region handles all of these; none may be missing or a blank area:

1. **Loading**: skeletons (`Skeleton`, or `DataTable loading`) that match the final layout. Do not use a spinner-only page or layout-shifting text.
2. **Empty**: `EmptyState` with a next step (for example "Create your first Workspace").
3. **Error**: `ErrorState` with a safe message and a retry. Never show raw server errors, stack traces or secrets.
4. **Success**: the data, plus a toast for every mutation.

Mutations: show a **toast for success and for failure** and keep safe inline errors next to the form field or dialog that failed (`FormField` `error`, `ConfirmDialog` `error`). Disable the submit control while pending to prevent duplicate requests. A failed response must never produce a success toast. Use `readFormError` (`@/lib/form-errors`) to map API validation errors to fields.

## Copy style

- Sentence case everywhere: "Create workspace" style for buttons and headings. Product and proper nouns keep their capitals (Seshat, Workspace and Global as scope names, MCP, API keys as a plain phrase).
- Short labels: one to three words for buttons, tabs and column headers ("Delete", "Upload files", "Last used").
- **No exclamation marks.** No jargon, no blame ("You failed"); say what happened and what to do ("Couldn't save. Try again.").
- Confirmation text states the consequence ("This deletes the Workspace and its files. This can't be undone.").
- Use "Workspace" and "Global" consistently; never "Project".

## Accessibility rules

- Everything is reachable and operable with the keyboard, in a logical order. Dialogs and sheets trap focus and return it to the opener. Escape closes.
- Focus is always visible: use the shared `focus-visible:outline-2 outline-ring` pattern; never `outline-none` without a replacement.
- Icon-only buttons have an accessible name (`aria-label`); decorative icons have `aria-hidden="true"`.
- Status changes and results that appear without a navigation are announced: `role="status"` / `aria-live="polite"` for progress and success, `role="alert"` for errors. (`ErrorState` and `ConfirmDialog` errors already do.)
- Colour is never the only signal: pair it with text or an icon (`StatusBadge`, `ScopeBadge`).
- Text and controls meet WCAG AA (see the contrast-safe pairings).
- Every form control has a visible label and, when invalid, `aria-invalid` and an associated error (`FormField`).
- Tables have an accessible name (`DataTable label`), sortable headers expose `aria-sort`, selection checkboxes are named per row (`getRowLabel`).
- No horizontal scrolling at **375 px** width: wrap, truncate or scroll inside the component. Respect `prefers-reduced-motion` and keep motion minimal.

## Page patterns

These are design patterns for pages that later feature specs build. They are **not** implementations and do not promise API fields or endpoints that do not exist; each feature spec defines its own contracts. Use the shared components above.

### Files

- Upload: a drag-and-drop zone that also works as a keyboard-operable "Upload files" button; multiple files at once, with a per-file row showing `FileTypeIcon`, name, progress and a `StatusBadge` or error with retry. Progress is announced through a polite live region.
- List: a `DataTable` with columns type icon, name, size, Collection, tags, status (`StatusBadge`) and upload time (`RelativeTime`). Search by name, filters for Collection, tag and status in a compact bar, sort by name, date, size and status, row selection with a bulk bar for delete (through `ConfirmDialog`), and cursor "Load more".
- Detail: metadata (type, size, Collection, tags), status with indexing timestamps and chunk count, and a chunk list showing section and line range for each chunk.

### Collections

- List: name, description, file count and dates, with "Create collection" in the `PageHeader` actions.
- Create and edit in a dialog (`FormField`s for name and description; edits send every editable field).
- Detail page with tabs Overview, Files (a `DataTable` of the Collection's files) and Search (search within the Collection).

### Search

- One large query input as the focus of the page, with filters in a compact bar below it (scope-appropriate: kind, Collection, tags, memory type).
- Results are rows: kind icon (`FileTypeIcon` or a memory icon), source name, an excerpt with the matched terms highlighted (use `<mark>` styled with tokens, not colour alone), relevance score, the Collection or memory type, and the location (page, section or line range).
- Selecting a row opens the file at that chunk, or the memory. Loading shows skeleton rows, no results shows `EmptyState`, failure shows `ErrorState`.

### Memories

- List: type badge, title or excerpt, tags, `StatusBadge` (`active`, `superseded`) and provenance (source or creating agent).
- Create and edit in a side `Sheet` (side `right`) with `FormField`s.
- Supersession is shown as a link between the superseded and the superseding memory, never as a hidden state.

### API Keys

- Table of keys: name, **masked** prefix, permissions summary, created and last used (`RelativeTime`), and status (`active`, `revoked`, `expired`).
- Creating a key opens a one-time secret dialog: the secret in a `CopyField` with a clear warning that it is shown once and cannot be retrieved again. The secret is never logged, stored in the page, or shown again after the dialog closes.

### MCP

- The endpoint in a `CopyField`.
- Client configuration tabs for Gilde, Claude Code and Claude Desktop, each with a `CodeSnippet` (use placeholders such as `<your-api-key>`, never real keys).
- For a selected key, the list of MCP tools that key's permissions allow.
