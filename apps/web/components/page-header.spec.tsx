// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { Button } from '@/components/ui/button';
import { PageHeader } from './page-header';

describe('PageHeader', () => {
  it('renders title as h1 with optional description and actions', async () => {
    const onClick = vi.fn();
    render(<PageHeader title="Files" description="All files" actions={<Button onClick={onClick}>Upload</Button>} />);
    expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeInTheDocument();
    expect(screen.getByText('All files')).toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Upload' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('omits description and actions when absent', () => {
    render(<PageHeader title="Only title" />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(document.querySelectorAll('p')).toHaveLength(0);
  });

  it('wraps and breaks long content instead of widening the page', () => {
    render(<PageHeader title={'x'.repeat(300)} description={'y'.repeat(300)} />);
    expect(screen.getByRole('banner').className).toContain('flex-wrap');
    expect(screen.getByRole('heading').className).toContain('break-words');
  });
});
