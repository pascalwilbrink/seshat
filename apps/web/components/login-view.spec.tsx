// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));
import { LoginView } from './login-view';

const fetchMock = vi.fn();
const assign = vi.fn();
beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(window, 'location', { value: { assign, pathname: '/', search: '' }, configurable: true });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fetchMock.mockReset();
  assign.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  window.sessionStorage.clear();
});

async function submit() {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'pw-fixture');
  await user.click(screen.getByRole('button', { name: 'Log in' }));
}

describe('LoginView', () => {
  it('has labelled fields', () => {
    render(<LoginView />);
    expect(screen.getByLabelText('Username')).toHaveAttribute('autocomplete', 'username');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
  });
  it('shows pending state, posts to the relative path and redirects locally on success', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => (resolve = r)));
    render(<LoginView next="/somewhere" />);
    await submit();
    expect(screen.getByRole('button', { name: 'Logging in…' })).toBeDisabled();
    expect(fetchMock.mock.calls[0][0]).toBe('/api/auth/login');
    resolve(Response.json({ kind: 'admin' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/somewhere'));
  });
  it('ignores non-local next targets', async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    render(<LoginView next="https://evil.example" />);
    await submit();
    await waitFor(() => expect(assign).toHaveBeenCalledWith('/'));
  });
  it('shows one generic failure and never echoes credentials', async () => {
    fetchMock.mockResolvedValue(new Response('{"message":"Invalid credentials"}', { status: 401 }));
    const { container } = render(<LoginView />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Login failed');
    expect(container.textContent).not.toContain('pw-fixture');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain('pw-fixture');
    expect(toast.success).not.toHaveBeenCalled();
  });
  it('shows an inline error and a toast when the network fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    render(<LoginView />);
    await submit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Login failed');
    expect(toast.error).toHaveBeenCalledWith('Could not reach Seshat. Try again.');
    expect(assign).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Log in' })).toBeEnabled();
  });
  it('queues a success message for after the full navigation, without credentials', async () => {
    fetchMock.mockResolvedValue(Response.json({}));
    render(<LoginView />);
    await submit();
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(window.sessionStorage.getItem('seshat:flash')).toBe('Signed in');
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain('pw-fixture');
    expect(toast.error).not.toHaveBeenCalled();
  });
  it('is a centred panel with a wordmark and no navigation', () => {
    render(<LoginView />);
    expect(screen.getByRole('heading', { name: 'Log in to Seshat' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument();
  });
  it('ignores a second submit while pending', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<LoginView />);
    await submit();
    expect(screen.getByLabelText('Username')).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
