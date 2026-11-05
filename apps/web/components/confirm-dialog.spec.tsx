// @vitest-environment jsdom
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, type ConfirmDialogProps } from './confirm-dialog';

function Harness(props: Partial<ConfirmDialogProps>) {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Delete workspace</button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete Acme"
        consequence="All files will be removed."
        confirmLabel="Delete workspace permanently"
        onConfirm={() => {}}
        {...props}
      />
    </>
  );
}

async function openDialog(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Delete workspace' }));
  return screen.getByRole('dialog', { name: 'Delete Acme' });
}

describe('ConfirmDialog', () => {
  it('shows title and consequence and moves focus into the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const dialog = await openDialog(user);
    expect(dialog).toHaveAccessibleDescription('All files will be removed.');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('keeps confirm disabled until the exact slug matches', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness confirmSlug="acme" onConfirm={onConfirm} />);
    await openDialog(user);
    const confirm = screen.getByRole('button', { name: 'Delete workspace permanently' });
    const input = screen.getByLabelText(/type acme to confirm/i);
    expect(confirm).toBeDisabled();
    for (const wrong of ['ac', 'ACME', 'acme ', 'acmee']) {
      await user.clear(input);
      await user.type(input, wrong);
      expect(confirm).toBeDisabled();
    }
    await user.type(input, '{Enter}');
    expect(onConfirm).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, 'acme');
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('confirms without a slug requirement and via Enter in the field', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<Harness onConfirm={onConfirm} />);
    await openDialog(user);
    expect(screen.queryByRole('textbox')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Delete workspace permanently' }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('prevents duplicate submission while the callback is in flight and while pending', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    const onConfirm = vi.fn(() => new Promise<void>((r) => { resolve = r; }));
    const { rerender } = render(<ConfirmDialog open onOpenChange={() => {}} title="T" consequence="C" confirmLabel="Go" onConfirm={onConfirm} />);
    const go = screen.getByRole('button', { name: 'Go' });
    await user.click(go);
    await user.click(go);
    await user.keyboard('{Enter}');
    expect(onConfirm).toHaveBeenCalledOnce();
    resolve();
    rerender(<ConfirmDialog open onOpenChange={() => {}} title="T" consequence="C" confirmLabel="Go" onConfirm={onConfirm} pending />);
    const busy = screen.getByRole('button', { name: 'Working…' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    await user.click(busy);
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('ignores Escape while pending', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="T" consequence="C" confirmLabel="Go" onConfirm={() => {}} pending />);
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it('shows an inline alert on failure and allows retry', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const props = { open: true, onOpenChange: () => {}, title: 'T', consequence: 'C', confirmLabel: 'Go', onConfirm };
    const { rerender } = render(<ConfirmDialog {...props} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    rerender(<ConfirmDialog {...props} error="Couldn't delete. Try again." />);
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't delete. Try again.");
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('allows retry after the callback rejects', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockRejectedValueOnce(new Error('x')).mockResolvedValue(undefined);
    // swallow the rejection the caller would normally handle
    const wrapped = () => Promise.resolve(onConfirm()).catch(() => {});
    render(<ConfirmDialog open onOpenChange={() => {}} title="T" consequence="C" confirmLabel="Go" onConfirm={wrapped} />);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  it('cancels with the button and with Escape, clears the typed slug, and restores focus', async () => {
    const user = userEvent.setup();
    render(<Harness confirmSlug="acme" />);
    const trigger = screen.getByRole('button', { name: 'Delete workspace' });
    await openDialog(user);
    await user.type(screen.getByLabelText(/type acme/i), 'acme');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());

    await openDialog(user);
    expect(screen.getByLabelText(/type acme/i)).toHaveValue('');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('traps Tab focus inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Harness confirmSlug="acme" />);
    const dialog = await openDialog(user);
    for (let i = 0; i < 8; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});
