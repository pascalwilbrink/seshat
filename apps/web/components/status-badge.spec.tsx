// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { STATUSES, StatusBadge } from './status-badge';

describe('StatusBadge', () => {
  it.each(STATUSES)('shows text for %s, not only colour', (status) => {
    const { container } = render(<StatusBadge status={status} />);
    expect(screen.getByText(status[0]!.toUpperCase() + status.slice(1))).toBeInTheDocument();
    expect(container.querySelector('[data-status]')).toHaveAttribute('data-status', status);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('spins only for processing and respects reduced motion', () => {
    const { container, rerender } = render(<StatusBadge status="processing" />);
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
    expect(container.querySelector('svg')?.getAttribute('class')).toContain('motion-reduce:animate-none');
    rerender(<StatusBadge status="indexed" />);
    expect(container.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');
  });

  it('uses distinct semantic variants for failure and success', () => {
    const { container, rerender } = render(<StatusBadge status="failed" />);
    expect(container.firstElementChild?.className).toContain('bg-destructive');
    rerender(<StatusBadge status="indexed" />);
    expect(container.firstElementChild?.className).toContain('bg-success');
  });
});
