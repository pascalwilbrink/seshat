import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NAV_AREAS } from '@/lib/navigation';

const webRoot = resolve(__dirname);
const repoRoot = resolve(webRoot, '../..');
const guide = readFileSync(resolve(repoRoot, 'docs/ui.md'), 'utf8');
const css = readFileSync(resolve(webRoot, 'app/globals.css'), 'utf8');

const COMPONENTS: Record<string, { file: string; exports: string[] }> = {
  PageHeader: { file: 'page-header', exports: ['PageHeader'] },
  StatCard: { file: 'stat-card', exports: ['StatCard'] },
  DataTable: { file: 'data-table', exports: ['DataTable'] },
  EmptyState: { file: 'empty-state', exports: ['EmptyState'] },
  ErrorState: { file: 'error-state', exports: ['ErrorState'] },
  StatusBadge: { file: 'status-badge', exports: ['StatusBadge', 'STATUSES'] },
  FileTypeIcon: { file: 'file-type-icon', exports: ['FileTypeIcon', 'fileKind'] },
  ScopeBadge: { file: 'scope-badge', exports: ['ScopeBadge'] },
  CopyField: { file: 'copy-field', exports: ['CopyField', 'copyWithToast'] },
  ConfirmDialog: { file: 'confirm-dialog', exports: ['ConfirmDialog'] },
  CodeSnippet: { file: 'code-snippet', exports: ['CodeSnippet'] },
  RelativeTime: { file: 'relative-time', exports: ['RelativeTime'] },
};

describe('docs/ui.md stays consistent with the code', () => {
  it('documents every shared component with a real import path and export', () => {
    for (const [name, { file, exports }] of Object.entries(COMPONENTS)) {
      expect(guide, name).toContain(`@/components/${file}`);
      const source = readFileSync(resolve(webRoot, `components/${file}.tsx`), 'utf8');
      for (const e of exports) expect(source, `${file} exports ${e}`).toMatch(new RegExp(`export (async )?(function|const) ${e}\\b`));
    }
  });

  it('only references component, lib and ui files that exist', () => {
    const paths = [...guide.matchAll(/@\/(components|lib)\/([a-z0-9/-]+)/g)].filter((m) => m[2] !== 'ui').map((m) => `${m[1]}/${m[2]}`);
    expect(paths.length).toBeGreaterThan(10);
    for (const p of paths) {
      const found = ['.ts', '.tsx', '/index.ts', '/index.tsx'].some((ext) => existsSync(resolve(webRoot, p + ext)));
      expect(found, p).toBe(true);
    }
  });

  it('lists every theme token in a table row and in globals.css', () => {
    const tokens = ['background', 'foreground', 'surface', 'popover', 'muted', 'border', 'input', 'primary', 'accent', 'destructive', 'success', 'warning', 'info', 'ring'];
    for (const t of tokens) {
      expect(guide, t).toContain(`\`${t}\``);
      expect(css, t).toMatch(new RegExp(`--${t}:`));
    }
    for (const hex of ['#0B0B10', '#8B5CF6', '#F4F4F5']) expect(guide).toContain(hex);
  });

  it('matches the navigation config', () => {
    expect(guide).toContain('apps/web/lib/navigation.ts');
    expect(NAV_AREAS.filter((a) => a.available).map((a) => a.id)).toEqual(['overview', 'memories', 'settings']);
    for (const a of NAV_AREAS) expect(guide, a.id).toContain(`\`${a.id}\``);
  });

  it('covers the six page patterns', () => {
    for (const h of ['### Files', '### Collections', '### Search', '### Memories', '### API Keys', '### MCP']) expect(guide).toContain(h);
  });

  it('is linked from AGENTS.md section 5 as binding', () => {
    const agents = readFileSync(resolve(repoRoot, 'AGENTS.md'), 'utf8');
    const section = agents.slice(agents.indexOf('## 5.'), agents.indexOf('## 6.'));
    expect(section).toContain('docs/ui.md');
    expect(section).toContain('binding');
  });
});
