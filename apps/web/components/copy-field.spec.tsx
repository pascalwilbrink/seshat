// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CopyField } from './copy-field';

let writeText: ReturnType<typeof vi.fn>;
function mockClipboard(impl: () => Promise<void>) {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.restoreAllMocks());

describe('CopyField', () => {
  it('shows the value in a monospace element and names the icon-only button', () => {
    mockClipboard(async () => {});
    render(<CopyField label="Endpoint URL" value="https://example.test/mcp" />);
    expect(screen.getByText('https://example.test/mcp').className).toContain('font-mono');
    expect(screen.getByRole('button', { name: 'Copy endpoint url' })).toBeInTheDocument();
  });

  it('copies on click and on keyboard activation, and toasts success', async () => {
    const user = userEvent.setup();
    mockClipboard(async () => {});
    render(<CopyField label="Endpoint URL" value="abc" />);
    await user.click(screen.getByRole('button', { name: /copy/i }));
    expect(writeText).toHaveBeenCalledWith('abc');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Endpoint URL copied'));
    screen.getByRole('button', { name: /copy/i }).focus();
    await user.keyboard('{Enter}');
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('toasts an error without the value when the clipboard rejects', async () => {
    mockClipboard(async () => { throw new Error('denied abc-secret'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<CopyField label="Secret" value="abc-secret" />);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('abc-secret');
    expect(log).not.toHaveBeenCalled();
  });

  it('reports an error when the Clipboard API is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    render(<CopyField label="Secret" value="x" />);
    await userEvent.click(screen.getByRole('button', { name: /copy/i }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
  });
});
