// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { FileTypeIcon, fileKind } from './file-type-icon';

describe('fileKind', () => {
  it.each([
    ['a.pdf', null, 'pdf'], ['a.md', null, 'markdown'], ['a.txt', null, 'text'], ['a.docx', null, 'docx'],
    ['a.json', null, 'json'], ['a.csv', null, 'csv'], ['a.ts', null, 'code'], ['a.PY', null, 'code'],
    ['noext', null, 'unknown'], ['a.zzz', null, 'unknown'], [null, null, 'unknown'],
    ['x', 'application/pdf', 'pdf'], ['x', 'text/markdown; charset=utf-8', 'markdown'], ['x', 'text/csv', 'csv'],
    ['x.pdf', 'application/octet-stream', 'pdf'],
  ] as const)('%s / %s -> %s', (name, mime, kind) => {
    expect(fileKind(name, mime)).toBe(kind);
  });
});

describe('FileTypeIcon', () => {
  it('is decorative by default', () => {
    const { container } = render(<FileTypeIcon name="a.pdf" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('svg')).toHaveAttribute('data-kind', 'pdf');
  });

  it('is labelled when it conveys the type on its own', () => {
    render(<FileTypeIcon name="a.md" labelled />);
    expect(screen.getByRole('img', { name: 'Markdown' })).toBeInTheDocument();
  });

  it('renders distinct kinds for all eight types', () => {
    const kinds = ['a.pdf', 'a.md', 'a.txt', 'a.docx', 'a.json', 'a.csv', 'a.ts', 'a'].map((n) => {
      const { container, unmount } = render(<FileTypeIcon name={n} />);
      const k = container.querySelector('svg')!.getAttribute('data-kind');
      unmount();
      return k;
    });
    expect(new Set(kinds).size).toBe(8);
  });
});
