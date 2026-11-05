// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { RelativeTime, formatRelative } from './relative-time';

const NOW = new Date('2026-11-05T12:00:00Z');

describe('formatRelative', () => {
  it.each([
    ['2026-11-05T11:59:50Z', 'just now'],
    ['2026-11-05T11:55:00Z', '5 minutes ago'],
    ['2026-11-05T09:00:00Z', '3 hours ago'],
    ['2026-11-04T12:00:00Z', 'yesterday'],
    ['2026-10-01T12:00:00Z', 'last month'],
    ['2024-11-05T12:00:00Z', '2 years ago'],
    ['2026-11-05T14:00:00Z', 'in 2 hours'],
  ])('%s -> %s', (value, expected) => {
    expect(formatRelative(new Date(value), NOW)).toBe(expected);
  });
});

describe('RelativeTime', () => {
  it('renders a semantic time element with the relative text', () => {
    render(<RelativeTime value="2026-11-05T09:00:00Z" now={NOW} />);
    const el = screen.getByText('3 hours ago');
    expect(el.tagName).toBe('TIME');
    expect(el).toHaveAttribute('datetime', '2026-11-05T09:00:00.000Z');
  });

  it('exposes the exact timestamp on keyboard focus', async () => {
    render(<RelativeTime value="2026-11-05T09:00:00Z" now={NOW} />);
    await userEvent.tab();
    expect(screen.getByText('3 hours ago')).toHaveFocus();
    expect((await screen.findAllByText('2026-11-05 09:00:00 UTC')).length).toBeGreaterThan(0);
  });

  it('exposes the exact timestamp on hover', async () => {
    render(<RelativeTime value="2026-11-05T09:00:00Z" now={NOW} />);
    await userEvent.hover(screen.getByText('3 hours ago'));
    expect((await screen.findAllByText('2026-11-05 09:00:00 UTC')).length).toBeGreaterThan(0);
  });

  it('shows the deterministic exact text first, then relative after mount (no hydration mismatch)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const { renderToString } = await import('react-dom/server');
    expect(renderToString(<RelativeTime value="2026-11-05T09:00:00Z" />)).toContain('2026-11-05 09:00:00 UTC');
    render(<RelativeTime value="2026-11-05T09:00:00Z" />);
    expect(await screen.findByText('3 hours ago')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('handles invalid values without throwing', () => {
    render(<RelativeTime value="not a date" now={NOW} />);
    expect(screen.getByText('Unknown time')).toBeInTheDocument();
  });

  it('accepts numbers and Dates', () => {
    render(<RelativeTime value={new Date('2026-11-05T11:00:00Z').getTime()} now={NOW} />);
    expect(screen.getByText('1 hour ago')).toBeInTheDocument();
  });
});
