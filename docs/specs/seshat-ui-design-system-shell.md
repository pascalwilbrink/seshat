## Goal

Give Seshat the look and feel of the v0 design the product owner chose (https://v0.app/chat/pUXUMMUOv8S): a polished, developer-focused dark product in the spirit of Linear and Supabase. This spec puts the design system and the app shell in place, moves the existing pages onto it, and writes a UI guide that every later page job follows, so Files, Collections, Search, Memories, API Keys and MCP pages arrive looking like one product.

## Context

- `apps/web` today: Next.js 16 App Router with routes `/login`, `/global/overview`, `/global/settings`, `/w/[slug]/overview`, `/w/[slug]/settings`; components `app-shell`, `scope-switcher`, `overview-view`, `global-settings-view`, `workspace-settings-view`, `login-view`, `form-field`, `workspaces-provider`; styling is one hand-written `app/globals.css` with CSS variables (`--bg #0b0b10`, `--surface #121219`, `--accent #8b5cf6`, `--text #f4f4f5`, `--text-muted #a1a1aa`, `--border #26262f`, `--radius 6px`). No Tailwind, component library or icon set. Tests use Vitest with Testing Library and jsdom. `apps/web/AGENTS.md` warns that this Next.js version differs from training data; read the bundled Next.js docs before changing config.
- The v0 brief behind the chosen design asks for: dark by default with background `#0B0B10`, violet accent `#8B5CF6`, primary text `#F4F4F5` and muted grey secondary text; subtle borders, rounded corners, restrained use of cards, generous spacing; Lucide icons; no gradients, heavy animation or colourful backgrounds; React, TypeScript, Tailwind CSS and shadcn/ui; a collapsible left sidebar with grouped navigation, a workspace selector and a user menu at the bottom; toasts; empty, loading and error states; reusable components; desktop first but responsive.
- The brief predates parts of the product model in `AGENTS.md`, which wins where they differ: Global is a scope next to Workspaces, not a Workspace; Memories is a main product area; Seshat itself is the MCP server and access goes through Workspace API keys; there is one admin user.
- Approved feature specs (files, ingestion, memories, search, API keys, MCP) each deliver their own pages. Their pages must use this design system.

## Behaviour

Foundation. Add Tailwind CSS (the version current for this Next.js release, configured the way its docs describe) and shadcn/ui (components generated into `apps/web/components/ui`, owned by the repo), Lucide icons (`lucide-react`) and a toast library compatible with shadcn/ui (for example Sonner). Define the theme once as CSS variables mapped to Tailwind and shadcn tokens: background `#0B0B10`, surface and popover a step lighter, border subtle (around `#26262F`), primary `#8B5CF6` with readable foreground, foreground `#F4F4F5`, muted foreground (around `#A1A1AA`), destructive red, plus success, warning and info colours for statuses, one radius scale (around 6–8 px), and the Geist Sans and Geist Mono fonts through `next/font` (mono for ids, keys, hashes and code). The product is dark only for now; tokens are named so a light theme can be added later. `globals.css` keeps only the base layer and tokens; the old hand-written classes are removed once nothing uses them.

App shell. A collapsible left sidebar (full width with labels, or icon-only with tooltips; the choice persists per browser) with:
- top: the Seshat wordmark;
- group "Knowledge": Overview, Files, Collections, Search, Memories;
- group "Developer": API Keys, MCP (Workspace scopes only);
- group "System": Settings;
- bottom: the scope selector and the user menu.

Navigation is driven by one typed config that lists every area with its group, icon, route pattern, which scopes it applies to and whether it is available. Only available areas are shown (today Overview and Settings); each later feature job marks its area available in that config and adds its route. Active item styling uses the accent. The scope selector is a dropdown (shadcn Command or Select) listing Global first with a distinct globe icon and label "Global", then Workspaces alphabetically, with "Create Workspace" at the bottom linking to the create flow; switching keeps the current area when it exists in the new scope, otherwise goes to Overview. The current scope is also shown at the top of every page (a breadcrumb such as "Global / Overview" or "Graphnous / Settings") with a visible badge that tells Global and Workspace apart. The user menu shows the admin username and "Sign out". Below 768 px the sidebar becomes a sheet opened from a header button.

Shared components, in `apps/web/components` on top of the shadcn primitives, each with a test: `PageHeader` (title, description, actions slot), `StatCard` (label, value, optional hint and icon), `DataTable` (column definitions, sorting, row selection with a bulk-action bar, cursor "Load more", loading skeleton rows, empty slot), `EmptyState` (icon, title, text, action), `ErrorState` (safe message and retry), `StatusBadge` (pending, processing with a subtle spinner, indexed, failed; active, superseded; revoked, expired), `FileTypeIcon` (PDF, Markdown, text, DOCX, JSON, CSV, source code, unknown), `ScopeBadge`, `CopyField` (monospace value with copy button and a "copied" toast), `ConfirmDialog` (title, consequence text, optional "type the slug to confirm" input, destructive button), `CodeSnippet` (monospace block with copy), `RelativeTime` (relative time with exact timestamp on hover), and the toaster mounted once in the root layout. Components use the tokens only, never raw colours.

Existing pages migrated. Login (centered panel with wordmark, username and password fields, inline error, loading state), Overview for Global and Workspaces (page header with scope name and description; a stat row using `StatCard` showing only stats the API provides today, built so later features add their stats such as files, collections, chunks and storage; an empty state "Create your first Workspace" when none exist), and Global and Workspace Settings (sections for general details, Workspace create, rename and the danger zone with slug-confirmed delete through `ConfirmDialog`) move onto the shell and components with the same behaviour and API calls. Success and failure of every mutation show a toast in addition to inline errors. Behaviour, routes and existing tests keep passing; tests are updated only where markup changes, never weakened.

UI guide. Add `docs/ui.md`, linked from `AGENTS.md` section 5, as the binding reference for later page work. It describes the tokens, typography, spacing, the navigation config and how to add an area, every shared component with when to use it, the states every page needs (loading skeletons, empty, error with retry, success toasts), copy style (sentence case, short labels, no exclamation marks), accessibility rules (keyboard reachable, visible focus, labelled icon buttons, `aria-live` for status changes, colour never the only signal, WCAG AA contrast), and page patterns taken from the chosen design for the pages that later specs build:
- Files: drag-and-drop multi-upload with per-file progress; table with type icon, name, size, Collection, tags, status and upload time; search, filter by Collection, tag and status; sort by name, date, size and status; bulk select and delete; a detail view with metadata, status with indexing timestamps and chunk count, and a chunk list with section and line range.
- Collections: list with name, description, file count and dates; create and edit dialog; a detail page with overview, files and search within the Collection.
- Search: one large query input, filters in a compact bar, results as rows with kind icon, source name, excerpt with highlighted terms, relevance score, Collection or memory type, and location; clicking opens the file at the chunk or the memory.
- Memories: list with type badge, title or excerpt, tags, status and provenance; create and edit in a side sheet; supersession shown as a link.
- API Keys: table with name, masked prefix, permissions summary, created, last used and status; the one-time secret dialog with `CopyField` and a clear warning.
- MCP: endpoint `CopyField`, client configuration tabs (Gilde, Claude Code, Claude Desktop) using `CodeSnippet`, and the tool list for a selected key.

Quality. The shell and every migrated page render without horizontal scrolling at 375 px and work fully with the keyboard. `pnpm build` and `pnpm test` pass. The PR includes screenshots of the shell (expanded and collapsed), Overview, Settings and Login at desktop width and of the mobile sheet.

## Acceptance criteria

- AC-1: Tailwind CSS, shadcn/ui (components in `apps/web/components/ui`), `lucide-react`, a shadcn-compatible toaster and Geist fonts are set up per the docs of the installed Next.js version, and `pnpm build` and `pnpm test` pass.
- AC-2: One set of theme tokens defines background `#0B0B10`, accent `#8B5CF6`, foreground `#F4F4F5`, muted foreground, surface, border, destructive and status colours and the radius scale, and components use tokens rather than raw colours.
- AC-3: The app shell has a collapsible sidebar (state persisted per browser) with the Knowledge, Developer and System groups, the scope selector and user menu at the bottom, and a mobile sheet below 768 px.
- AC-4: Navigation comes from one typed config with group, icon, routes, applicable scopes and availability; only available areas are shown (Overview and Settings today), and adding an area needs only a config entry and its route.
- AC-5: The scope selector lists Global first with a distinct icon, then Workspaces alphabetically, offers Create Workspace, and keeps the current area when switching where possible; every page shows the scope in a breadcrumb with a badge that distinguishes Global from a Workspace.
- AC-6: The shared components `PageHeader`, `StatCard`, `DataTable`, `EmptyState`, `ErrorState`, `StatusBadge`, `FileTypeIcon`, `ScopeBadge`, `CopyField`, `ConfirmDialog`, `CodeSnippet` and `RelativeTime` exist with tests, and the toaster is mounted once.
- AC-7: Login, Overview and Settings for Global and Workspaces use the shell and shared components with unchanged routes, behaviour and API calls, toasts for mutation results, and all loading, empty, success and failure states; the old CSS classes are removed.
- AC-8: Every migrated page and the shell have no horizontal scrolling at 375 px, are fully keyboard operable with visible focus, label icon-only buttons, and meet WCAG AA contrast.
- AC-9: `docs/ui.md` documents tokens, typography, navigation, shared components, required states, copy style, accessibility rules and the page patterns for Files, Collections, Search, Memories, API Keys and MCP, and `AGENTS.md` section 5 links to it as binding for UI work.
- AC-10: The PR includes desktop screenshots of the expanded and collapsed shell, Login, Overview and Settings, and a screenshot of the mobile navigation sheet.

## Out of scope

- Building the Files, Collections, Search, Memories, API Keys and MCP pages themselves (their feature specs do that, following `docs/ui.md`).
- An Integrations area, search history, configurable embedding provider or chunking settings in the UI, multiple users and profile settings: these appear in the v0 brief but are not part of Seshat's current plan.
- A light theme, mock data and a command palette.

## Open questions

None.
