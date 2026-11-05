// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Database } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('renders title and description with a decorative default icon', () => {
    const { container } = render(<EmptyState title="No files" description="Upload one to start" />);
    expect(screen.getByText('No files')).toBeInTheDocument();
    expect(screen.getByText('Upload one to start')).toBeInTheDocument();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('accepts a custom icon', () => {
    const { container } = render(<EmptyState title="t" icon={Database} />);
    expect(container.querySelector('svg')).toBeInTheDocument();
  });

  it('fires the action callback by keyboard', async () => {
    const onAction = vi.fn();
    render(<EmptyState title="t" action={<Button onClick={onAction}>Create</Button>} />);
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('has no action region and breaks long text', () => {
    render(<EmptyState title={'w'.repeat(300)} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('w'.repeat(300)).className).toContain('break-words');
  });
});
