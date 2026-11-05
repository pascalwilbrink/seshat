import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('geist/font/sans', () => ({ GeistSans: { variable: 'font-geist-sans-mock' } }));
vi.mock('geist/font/mono', () => ({ GeistMono: { variable: 'font-geist-mono-mock' } }));
vi.mock('@/components/ui/sonner', () => ({ Toaster: () => <div data-testid="toaster" /> }));

import RootLayout from './layout';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === 'node_modules' || name === '.next') return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx$/.test(path) && !/\.spec\.tsx$/.test(path) ? [path] : [];
  });
}

describe('RootLayout', () => {
  it('mounts exactly one toaster around every page, including Login', () => {
    const html = renderToStaticMarkup(<RootLayout><main>page</main></RootLayout>);
    expect(html.match(/data-testid="toaster"/g)).toHaveLength(1);
    expect(html).toContain('font-geist-sans-mock');
    expect(html).toContain('font-geist-mono-mock');
  });

  it('has no page-level or component-level toaster mounts', () => {
    const root = join(__dirname, '..');
    const offenders = [...sources(join(root, 'app')), ...sources(join(root, 'components'))]
      .filter((f) => !f.endsWith(join('app', 'layout.tsx')) && !f.endsWith(join('ui', 'sonner.tsx')))
      .filter((f) => /<Toaster\b/.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
