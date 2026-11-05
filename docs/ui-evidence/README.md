# UI browser evidence

Real-Chromium validation of the design system and shell (spec `seshat-ui-design-system-shell`, AC-1, AC-8, AC-10).
`report.md` is the latest run; the PNGs are the screenshots it captured.

## Reproduce

```sh
pnpm install
pnpm --filter @seshat/web test:browser   # builds @seshat/domain and the web app, then drives Chromium
```

- Harness: `apps/web/e2e/run.mjs` (playwright-core + axe-core, dev dependencies; deliberately not a Vitest spec, so `pnpm test` stays jsdom-only).
- It starts `apps/web/e2e/stub-api.mjs`, an in-memory stand-in for the API with fixture data only (fixture user and password are not secrets; no real Workspace data), then `next start` pointed at it with `API_URL`.
- Needs a Chromium: playwright-core uses the one from `PLAYWRIGHT_BROWSERS_PATH`, or set `CHROMIUM_PATH` to a binary.
- It rewrites `report.md` and the screenshots in this folder and exits non-zero on any failure.

## What is checked

Login, Global/Workspace Overview and Settings (including a very long Workspace name) at 1280 px and 375 px, plus 320 px: `scrollWidth <= viewport`;
error, empty, unknown-Workspace and loading states at 375 px; axe-core (WCAG 2.0/2.1 A+AA, best-practice, includes colour contrast) on every page and on the open sheet and delete dialog;
sidebar expanded, collapsed and reloaded; the 768/767 px boundary; the mobile sheet (focus trap, Escape, focus return); the scope selector order, Create Workspace item and area retention; user menu;
the slug-confirmed delete dialog, rename and create forms, keyboard only; toasts inside an `aria-live` region; a Tab tour proving every stop has an accessible name and a visible focus indicator.

## Defects found and fixed at the source

- Login had no `h1` (axe `page-has-heading-one`): `CardTitle` takes an `as` prop and the Login title is an `h1`.
- Account menu button: the avatar initial made the visible text differ from the accessible name (`label-content-name-mismatch`): the initial is now an icon.
- Links in `text-primary` on `surface` are 4.4:1 (below AA 4.5:1): Workspace links and file download links now use `text-foreground underline`; `docs/ui.md` and `globals.css.spec.ts` record that primary text is AA on `background` only.

## Manual checks and limits

Automated scanners cannot prove everything. Checked by eye on the screenshots: Global vs Workspace distinction (badge and selector icon), collapsed rail tooltips/labels, sheet layout at 375 px, no clipped long names.
Not covered: screen-reader speech output, Firefox/Safari, forced-colours mode, text-only zoom beyond 320 px reflow.

## Screenshots

| File | Shows |
| --- | --- |
| `shell-expanded-desktop.png`, `shell-collapsed-desktop.png` | Shell, 240 px and 64 px sidebar |
| `login-desktop.png` | Login |
| `global-overview-desktop.png`, `workspace-overview-desktop.png` | Overview, both scopes |
| `global-settings-desktop.png`, `workspace-settings-desktop.png` | Settings, both scopes |
| `mobile-navigation-sheet.png` | Navigation sheet at 375 px |
| `scope-selector-open-desktop.png`, `delete-workspace-dialog-desktop.png` | Scope menu, slug-confirmed dialog |
