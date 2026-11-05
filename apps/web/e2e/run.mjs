// Browser validation + screenshot harness for the design system and shell (real Chromium, not jsdom).
//   pnpm --filter @seshat/web test:browser
// Starts a stub API (e2e/stub-api.mjs) and `next build` + `next start` against it, drives Chromium with
// playwright-core, scans pages with axe-core, and writes screenshots and report.md to
// docs/ui-evidence/. Not part of `pnpm test` (Vitest); needs a Chromium (see docs/ui-evidence/README.md).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { FIXTURE_PASSWORD, FIXTURE_USER, LONG_NAME, LONG_SLUG, startStub } from './stub-api.mjs';

const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const webDir = fileURLToPath(new URL('..', import.meta.url));
const outDir = fileURLToPath(new URL('../../../docs/ui-evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const results = [];
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};
async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, typeof detail === 'string' ? detail : '');
  } catch (e) {
    record(name, false, String(e?.message ?? e).split('\n')[0]);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const { server: stub, port: apiPort } = await startStub();
const webPort = await freePort();
const base = `http://127.0.0.1:${webPort}`;
const stubUrl = `http://127.0.0.1:${apiPort}/__stub/mode`;
const setMode = (mode) => fetch(stubUrl, { method: 'POST', body: JSON.stringify(mode) });
const webEnv = { ...process.env, API_URL: `http://127.0.0.1:${apiPort}`, NEXT_DIST_DIR: '.next-browser', NEXT_TELEMETRY_DISABLED: '1' };
// A production build is what users get and hydrates deterministically (no HMR socket).
await new Promise((resolve, reject) => {
  const domain = spawn('pnpm', ['--filter', '@seshat/domain', 'build'], { cwd: webDir, stdio: 'ignore' });
  domain.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('@seshat/domain build failed'))));
});
await new Promise((resolve, reject) => {
  const build = spawn('pnpm', ['exec', 'next', 'build'], { cwd: webDir, env: webEnv, stdio: 'ignore' });
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`next build failed (${code})`))));
});
const web = spawn('pnpm', ['exec', 'next', 'start', '-p', String(webPort)], { cwd: webDir, env: webEnv, stdio: 'ignore', detached: true });
let browser;
async function cleanup() {
  await browser?.close().catch(() => {});
  try {
    process.kill(-web.pid, 'SIGTERM'); // the whole process group, so no orphaned next-server
  } catch {}
  stub.close();
}
try {
  for (let i = 0; ; i++) {
    try {
      await fetch(`${base}/login`);
      break;
    } catch {
      if (i > 120) throw new Error('web did not start');
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox'] });

  const DESKTOP = { width: 1280, height: 800 };
  const MOBILE = { width: 375, height: 700 };
  async function newPage(viewport, { login = true, deviceScaleFactor = 1 } = {}) {
    const context = await browser.newContext({ viewport, deviceScaleFactor, reducedMotion: 'reduce' });
    const page = await context.newPage();
    if (login) {
      await context.addCookies([{ name: 'seshat_session', value: 'fixture', url: base }]);
    }
    return page;
  }
  const settle = async (page) => {
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(300);
  };
  const noHScroll = (page) =>
    page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, body: document.body.scrollWidth, inner: window.innerWidth }));
  async function assertNoHScroll(page, label) {
    const m = await noHScroll(page);
    assert(m.scroll <= m.inner && m.body <= m.inner, `${label}: scrollWidth ${m.scroll}/${m.body} > viewport ${m.inner}`);
  }
  async function axe(page, label) {
    await page.evaluate(axeSource);
    const r = await page.evaluate(() =>
      // eslint-disable-next-line no-undef
      axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'] }, rules: { region: { enabled: false } } }),
    );
    const bad = r.violations.map((v) => `${v.id}(${v.nodes.length}): ${v.nodes[0].target.join(' ')}`);
    assert(bad.length === 0, `${label}: axe ${bad.join('; ')}`);
    return `axe: 0 violations, ${r.passes.length} rules passed (${r.incomplete.length} need manual review)`;
  }
  const shot = (page, name) => page.screenshot({ path: `${outDir}${name}.png` });

  await setMode({ reset: true });

  // ---- Login --------------------------------------------------------------------------
  for (const [vpName, vp] of [['desktop', DESKTOP], ['375', MOBILE]]) {
    await check(`Login ${vpName}: no horizontal scroll + axe`, async () => {
      const page = await newPage(vp, { login: false, deviceScaleFactor: vpName === 'desktop' ? 2 : 1 });
      await page.goto(`${base}/login`);
      await settle(page);
      await assertNoHScroll(page, 'login');
      if (vpName === 'desktop') await shot(page, 'login-desktop');
      const d = await axe(page, 'login');
      await page.context().close();
      return d;
    });
  }
  await check('Login: keyboard-only failure then success, error announced via role=alert', async () => {
    const page = await newPage(DESKTOP, { login: false });
    await page.goto(`${base}/login`);
    await settle(page);
    await page.keyboard.press('Tab');
    assert((await page.evaluate(() => document.activeElement?.id)) === 'username', 'first Tab stop is Username');
    await page.keyboard.type(FIXTURE_USER);
    await page.keyboard.press('Tab');
    await page.keyboard.type('wrong');
    await page.keyboard.press('Enter');
    await page.getByRole('alert').filter({ hasText: 'Login failed' }).waitFor();
    await page.fill('#password', FIXTURE_PASSWORD);
    await page.focus('#password');
    await page.keyboard.press('Enter');
    await page.waitForURL(`${base}/`, { timeout: 20000 }).catch(() => {});
    await page.waitForURL(/\/global\/overview/, { timeout: 20000 });
    await page.context().close();
  });

  // ---- Pages at desktop and 375 ---------------------------------------------------------
  const pages = [
    ['global-overview', '/global/overview'],
    ['global-settings', '/global/settings'],
    ['workspace-overview', '/w/acme/overview'],
    ['workspace-settings', '/w/acme/settings'],
    ['long-workspace-overview', `/w/${LONG_SLUG}/overview`],
    ['long-workspace-settings', `/w/${LONG_SLUG}/settings`],
  ];
  for (const [name, path] of pages) {
    for (const [vpName, vp] of [['desktop', DESKTOP], ['375', MOBILE]]) {
      await check(`${name} ${vpName}: no horizontal scroll + axe (incl. colour contrast)`, async () => {
        const page = await newPage(vp, { deviceScaleFactor: vpName === 'desktop' ? 2 : 1 });
        await page.goto(`${base}${path}`);
        await settle(page);
        await assertNoHScroll(page, name);
        if (vpName === 'desktop' && !name.startsWith('long')) await shot(page, `${name}-desktop`);
        const d = await axe(page, name);
        await page.context().close();
        return d;
      });
    }
  }

  // ---- Error / loading / empty states at 375 --------------------------------------------
  const stateCases = [
    ['Workspaces API error', { workspaces: 'error' }, '/global/settings'],
    ['Workspaces API error (workspace page)', { workspaces: 'error' }, '/w/acme/overview'],
    ['Overview API error', { overview: 'error' }, '/global/overview'],
    ['Workspace overview API error', { overview: 'error' }, '/w/acme/overview'],
    ['Empty (no Workspaces) global overview', { empty: true }, '/global/overview'],
    ['Empty (no Workspaces) global settings', { empty: true }, '/global/settings'],
    ['Unknown Workspace', {}, '/w/does-not-exist/overview'],
    ['Loading (slow API)', { delayMs: 2500 }, '/global/settings'],
  ];
  for (const [label, mode, path] of stateCases) {
    await check(`State "${label}" at 375: no horizontal scroll + axe`, async () => {
      await setMode({ reset: true, ...mode });
      const page = await newPage(MOBILE);
      await page.goto(`${base}${path}`);
      await page.waitForTimeout(label.startsWith('Loading') ? 600 : 1200);
      if (label.startsWith('Loading')) assert((await page.locator('[aria-busy="true"]').count()) > 0, 'loading state (aria-busy) visible');
      await assertNoHScroll(page, label);
      const d = await axe(page, label);
      await page.context().close();
      await setMode({ reset: true });
      return d;
    });
  }

  // ---- Sidebar expanded / collapsed / reloaded --------------------------------------------
  await check('Sidebar: expanded -> collapsed -> persists across reload -> expands again', async () => {
    const page = await newPage(DESKTOP, { deviceScaleFactor: 2 });
    await page.goto(`${base}/global/overview`);
    await settle(page);
    const aside = page.locator('aside[aria-label="Sidebar"]');
    assert((await aside.getAttribute('data-collapsed')) === 'false', 'starts expanded');
    assert((await aside.boundingBox()).width === 240, 'expanded width 240');
    await shot(page, 'shell-expanded-desktop');
    await page.getByRole('button', { name: 'Collapse sidebar' }).click();
    assert((await aside.getAttribute('data-collapsed')) === 'true', 'collapsed');
    await page.waitForTimeout(200);
    assert((await aside.boundingBox()).width === 64, 'collapsed width 64');
    await shot(page, 'shell-collapsed-desktop');
    await page.reload();
    await settle(page);
    assert((await page.locator('aside[aria-label="Sidebar"]').getAttribute('data-collapsed')) === 'true', 'collapsed state survives reload');
    assert((await page.getByRole('link', { name: 'Overview' }).first().isVisible()), 'collapsed nav link keeps its accessible name');
    await assertNoHScroll(page, 'collapsed shell');
    await page.getByRole('button', { name: 'Expand sidebar' }).click();
    await page.reload();
    await settle(page);
    assert((await page.locator('aside[aria-label="Sidebar"]').getAttribute('data-collapsed')) === 'false', 'expanded state survives reload');
    await page.context().close();
  });

  // ---- 768 boundary + sheet ---------------------------------------------------------------
  await check('Boundary: 768 px shows the sidebar, 767 px shows the sheet trigger', async () => {
    for (const [w, sidebar] of [[768, true], [767, false]]) {
      const page = await newPage({ width: w, height: 800 });
      await page.goto(`${base}/global/overview`);
      await settle(page);
      assert((await page.locator('aside[aria-label="Sidebar"]').isVisible()) === sidebar, `${w}px sidebar visible=${sidebar}`);
      assert((await page.getByRole('button', { name: 'Open navigation' }).isVisible()) === !sidebar, `${w}px Open navigation visible=${!sidebar}`);
      assert((await page.getByRole('button', { name: /Collapse sidebar|Expand sidebar/ }).isVisible()) === sidebar, `${w}px collapse button visible=${sidebar}`);
      await assertNoHScroll(page, `${w}px`);
      await page.context().close();
    }
  });
  await check('Sheet (375): opens, traps focus, Escape closes and returns focus; screenshot', async () => {
    const page = await newPage(MOBILE, { deviceScaleFactor: 2 });
    await page.goto(`${base}/global/overview`);
    await settle(page);
    const trigger = page.getByRole('button', { name: 'Open navigation' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForTimeout(400);
    await shot(page, 'mobile-navigation-sheet');
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), `focus left the sheet after ${i + 1} Tabs`);
    }
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press('Shift+Tab');
      assert(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'Shift+Tab left the sheet');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await trigger.evaluate((el) => el === document.activeElement), 'focus returns to the Open navigation button');
    await page.context().close();
  });
  await check('Sheet (375): axe while open, and selecting a link closes it', async () => {
    const page = await newPage(MOBILE);
    await page.goto(`${base}/global/overview`);
    await settle(page);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('dialog').waitFor();
    await page.waitForTimeout(400);
    const d = await axe(page, 'sheet');
    await page.getByRole('dialog').getByRole('link', { name: 'Settings' }).click();
    await page.waitForURL(/\/global\/settings/);
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.context().close();
    return d;
  });

  // ---- Scope selector ordering and retention, user menu (keyboard only) ----------------------
  await check('Scope selector: keyboard-only, Global first, Workspaces alphabetical, Create Workspace; keeps the area', async () => {
    const page = await newPage(DESKTOP, { deviceScaleFactor: 2 });
    await page.goto(`${base}/global/settings`);
    await settle(page);
    const trigger = page.getByRole('button', { name: /^Scope: Global/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    const items = await page.getByRole('menuitem').allInnerTexts();
    const labels = items.map((t) => t.trim());
    const expected = ['Global', 'Acme', 'beta labs', LONG_NAME];
    assert(JSON.stringify(labels.slice(0, 4)) === JSON.stringify(expected), `order: ${JSON.stringify(labels)}`);
    assert(labels.some((l) => /Create Workspace/i.test(l)), `Create Workspace item present: ${JSON.stringify(labels)}`);
    await assertNoHScroll(page, 'scope menu open');
    await shot(page, 'scope-selector-open-desktop');
    for (let i = 0; i < 6 && !(await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Acme')); i++) await page.keyboard.press('ArrowDown');
    assert(await page.evaluate(() => document.activeElement?.textContent?.trim() === 'Acme'), 'arrow keys reach the Acme item');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/w\/acme\/settings$/);
    // Escape returns focus to the trigger.
    await page.getByRole('button', { name: /^Scope: Acme/ }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menu').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.startsWith('Scope:')), 'focus returns to scope trigger');
    await page.context().close();
  });
  await check('User menu: keyboard-only open/close, focus returns, named trigger', async () => {
    const page = await newPage(DESKTOP);
    await page.goto(`${base}/global/overview`);
    await settle(page);
    const trigger = page.getByRole('button', { name: `Account menu for ${FIXTURE_USER}` });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('menuitem', { name: 'Sign out' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menu').waitFor({ state: 'hidden' });
    assert(await trigger.evaluate((el) => el === document.activeElement), 'focus returns to account button');
    await page.context().close();
  });

  // ---- Slug-confirmed modal, keyboard only; toasts / aria-live -------------------------------
  await check('Workspace delete modal: keyboard-only, focus trap, slug gate, Escape returns focus', async () => {
    await setMode({ reset: true });
    const page = await newPage(MOBILE);
    await page.goto(`${base}/w/acme/settings`);
    await settle(page);
    const open = page.getByRole('button', { name: 'Delete Workspace' }).first();
    await open.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForTimeout(300);
    await assertNoHScroll(page, 'delete dialog @375');
    const confirm = dialog.getByRole('button', { name: 'Delete Workspace' });
    assert(await confirm.isDisabled(), 'confirm disabled until the slug is typed');
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('Tab');
      assert(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), 'focus left the dialog');
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    assert(await open.evaluate((el) => el === document.activeElement), 'focus returns to the trigger');
    await page.context().close();
  });
  await check('Workspace delete modal: typed slug enables confirm, Enter deletes, toast announced, redirect to Global', async () => {
    await setMode({ reset: true });
    const page = await newPage(DESKTOP, { deviceScaleFactor: 2 });
    await page.goto(`${base}/w/beta-labs/settings`);
    await settle(page);
    await page.getByRole('button', { name: 'Delete Workspace' }).first().focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog');
    await dialog.waitFor();
    await page.waitForTimeout(300);
    const d = await axe(page, 'delete dialog');
    await shot(page, 'delete-workspace-dialog-desktop');
    await page.keyboard.type('beta-labs');
    const confirm = dialog.getByRole('button', { name: 'Delete Workspace' });
    assert(await confirm.isEnabled(), 'confirm enabled for matching slug');
    await page.keyboard.press('Enter');
    await page.waitForURL(/\/global\/overview/);
    const live = page.locator('[aria-live]').filter({ hasText: 'Workspace deleted' });
    await live.first().waitFor({ state: 'attached', timeout: 5000 });
    await page.context().close();
    await setMode({ reset: true });
    return `${d}; toast text found inside an aria-live region`;
  });
  await check('Rename save: keyboard-only, success toast inside aria-live region', async () => {
    await setMode({ reset: true });
    const page = await newPage(DESKTOP);
    await page.goto(`${base}/w/acme/settings`);
    await settle(page);
    await page.getByLabel('Name', { exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.locator('[aria-live]').filter({ hasText: 'Workspace saved' }).first().waitFor({ state: 'attached', timeout: 5000 });
    await page.context().close();
  });
  await check('Create Workspace form: keyboard-only create', async () => {
    await setMode({ reset: true });
    const page = await newPage(DESKTOP);
    await page.goto(`${base}/global/settings`);
    await settle(page);
    await page.getByLabel('Name', { exact: true }).first().focus();
    await page.keyboard.type('Gamma');
    await page.keyboard.press('Tab');
    const slugField = page.getByLabel('Slug (optional)', { exact: true });
    if (await slugField.count()) {
      await slugField.focus();
      await page.keyboard.type('gamma');
    }
    await page.keyboard.press('Enter');
    await page.getByText('Workspace "Gamma" created').first().waitFor({ timeout: 5000 });
    await page.context().close();
    await setMode({ reset: true });
  });

  // ---- Visible focus and accessible names ------------------------------------------------------
  for (const [name, path] of [['Global Overview', '/global/overview'], ['Workspace Settings', '/w/acme/settings'], ['Global Settings', '/global/settings']]) {
    await check(`Keyboard tour ${name}: every Tab stop has a visible focus indicator and an accessible name`, async () => {
      const page = await newPage(DESKTOP);
      await page.goto(`${base}${path}`);
      await settle(page);
      const seen = new Set();
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        const info = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body) return null;
          const cs = getComputedStyle(el);
          const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0;
          const ring = cs.boxShadow !== 'none';
          const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '').trim() || (el.labels?.[0]?.textContent ?? '').trim();
          return { key: `${el.tagName}:${name}:${el.id}`, visible: outline || ring, name, tag: el.tagName, html: el.outerHTML.slice(0, 160) };
        });
        if (!info) continue;
        if (seen.has(info.key)) break;
        seen.add(info.key);
        assert(info.name, `Tab stop ${i + 1} has no accessible name: ${info.html}`);
        assert(info.visible, `Tab stop "${info.name}" has no visible focus indicator`);
      }
      await page.context().close();
      return `${seen.size} tab stops checked`;
    });
  }

  // ---- Zoom / text reflow smoke: 320 px ---------------------------------------------------------
  await check('Shell and pages at 320 px: no horizontal scroll', async () => {
    const page = await newPage({ width: 320, height: 640 });
    for (const [name, path] of pages) {
      await page.goto(`${base}${path}`);
      await settle(page);
      await assertNoHScroll(page, `${name} @320`);
    }
    await page.context().close();
  });
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
const report = [
  '# Browser validation report',
  '',
  `Generated by \`pnpm --filter @seshat/web test:browser\` (Chromium via playwright-core, axe-core WCAG 2.0/2.1 A and AA + best-practice rules) on ${new Date().toISOString().slice(0, 10)}.`,
  `Result: ${results.length - failed.length}/${results.length} checks passed.`,
  '',
  '| Result | Check | Detail |',
  '| --- | --- | --- |',
  ...results.map((r) => `| ${r.ok ? 'pass' : '**FAIL**'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
writeFileSync(`${outDir}report.md`, report);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
