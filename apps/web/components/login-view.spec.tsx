// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  });
});
