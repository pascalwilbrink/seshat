// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Database } from 'lucide-react';
import { StatCard } from './stat-card';

describe('StatCard', () => {
  it('shows label, value and hint', () => {
    render(<StatCard label="Files" value={12} hint="Across 2 collections" />);
    expect(screen.getByText('Files')).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('Across 2 collections')).toBeInTheDocument();
  });

  it('renders a decorative icon only when given', () => {
    const { container, rerender } = render(<StatCard label="A" value="1" />);
    expect(container.querySelector('svg')).toBeNull();
    rerender(<StatCard label="A" value="1" icon={Database} />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('allows zero as a real value and wraps long content', () => {
    render(<StatCard label={'l'.repeat(200)} value={0} />);
    expect(screen.getByText('0').className).toContain('break-words');
  });
});
