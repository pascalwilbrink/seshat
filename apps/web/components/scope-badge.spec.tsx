// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ScopeBadge } from './scope-badge';

describe('ScopeBadge', () => {
  it('labels Global and Workspace explicitly', () => {
    const { rerender } = render(<ScopeBadge scope="global" />);
    expect(screen.getByText('Global')).toBeInTheDocument();
    rerender(<ScopeBadge scope="workspace" />);
    expect(screen.getByText('Workspace')).toBeInTheDocument();
  });

  it('differs by more than colour: icon and style', () => {
    const { container, rerender } = render(<ScopeBadge scope="global" />);
    const global = { html: container.querySelector('svg')!.innerHTML, cls: container.firstElementChild!.className };
    rerender(<ScopeBadge scope="workspace" />);
    expect(container.querySelector('svg')!.innerHTML).not.toBe(global.html);
    expect(container.firstElementChild!.className).not.toBe(global.cls);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
