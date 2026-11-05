// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

import { CodeSnippet } from './code-snippet';

let writeText: ReturnType<typeof vi.fn>;
function mockClipboard(impl: () => Promise<void>) {
  writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
}
beforeEach(() => vi.clearAllMocks());

describe('CodeSnippet', () => {
  const long = 'x'.repeat(500);

  it('renders a token-styled monospace block with bounded internal overflow', () => {
    mockClipboard(async () => {});
    render(<CodeSnippet label="Config" code={long} />);
    const block = screen.getByLabelText('Config');
    expect(block.className).toContain('font-mono');
    expect(block.className).toContain('overflow-auto');
    expect(block.className).toContain('max-w-full');
    expect(block.className).not.toMatch(/#|rgb\(|(bg|text)-(white|black)/);
    expect(block).toHaveAttribute('tabindex', '0');
  });

  it('copies the code and toasts success, via keyboard', async () => {
    const user = userEvent.setup();
    mockClipboard(async () => {});
    render(<CodeSnippet label="Config" code={"line1\nline2"} />);
    await user.tab(); // block
    await user.tab(); // copy button
    expect(screen.getByRole('button', { name: 'Copy config' })).toHaveFocus();
    await user.keyboard(' ');
    expect(writeText).toHaveBeenCalledWith('line1\nline2');
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Config copied'));
  });

  it('toasts an error when the clipboard rejects', async () => {
    mockClipboard(async () => { throw new Error('nope'); });
    render(<CodeSnippet label="Config" code="secret-token" />);
    await userEvent.click(screen.getByRole('button', { name: 'Copy config' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('secret-token');
  });
});
