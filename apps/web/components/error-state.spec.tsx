// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ErrorState } from './error-state';

describe('ErrorState', () => {
  it('announces a safe message as an alert', () => {
    render(<ErrorState message="Could not load files." />);
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Something went wrong');
    expect(alert).toHaveTextContent('Could not load files.');
  });

  it('retries on click and by keyboard', async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await userEvent.keyboard('{Enter}');
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('supports a custom title and retry label, and no retry without a callback', () => {
    const { rerender } = render(<ErrorState title="Load failed" retryLabel="Reload" onRetry={() => {}} />);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    rerender(<ErrorState title="Load failed" />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('keeps the icon decorative', () => {
    const { container } = render(<ErrorState />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});
