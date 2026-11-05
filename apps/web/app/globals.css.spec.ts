import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(__dirname, 'globals.css'), 'utf8');
const root = css.match(/:root\s*{([^}]*)}/)![1]!;
const tokens = Object.fromEntries([...root.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})\s*;/gi)].map((m) => [m[1]!, m[2]!.toLowerCase()]));

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('theme tokens', () => {
  it('defines the brand palette', () => {
    expect(tokens.background).toBe('#0b0b10');
    expect(tokens.primary).toBe('#8b5cf6');
    expect(tokens.foreground).toBe('#f4f4f5');
  });

  it.each([
    ['foreground', 'background'], ['foreground', 'surface'], ['muted-foreground', 'background'], ['muted-foreground', 'surface'],
    ['muted-foreground', 'muted'], ['popover-foreground', 'popover'], ['primary-foreground', 'primary'],
    ['destructive-foreground', 'destructive'], ['success-foreground', 'success'], ['warning-foreground', 'warning'],
    ['info-foreground', 'info'], ['accent-foreground', 'accent'], ['primary', 'background'], ['destructive', 'surface'],
  ])('%s on %s meets AA text contrast', (fg, bg) => {
    expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(['ring', 'input'])('%s is a 3:1 non-text contrast against the background', (t) => {
    expect(contrast(tokens[t]!, tokens.background!)).toBeGreaterThanOrEqual(3);
  });

  it('white text on the primary would fail, so primary text is dark', () => {
    expect(contrast('#ffffff', tokens.primary!)).toBeLessThan(4.5);
  });

  it('has no gradients, no light theme, and no raw colours outside the :root palette', () => {
    expect(css).not.toMatch(/gradient\(/);
    expect(css).not.toMatch(/prefers-color-scheme|color-scheme:\s*light/);
    expect(css.replace(root, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });

  it('contains only Tailwind integration, tokens and the base layer (no handwritten component classes)', () => {
    expect(css).not.toMatch(/@layer legacy/);
    const withoutBlocks = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...withoutBlocks.matchAll(/(?:^|})\s*([.#][\w-]+)[^{}]*{/gm)].map((m) => m[1]);
    expect(selectors).toEqual([]);
  });
});
