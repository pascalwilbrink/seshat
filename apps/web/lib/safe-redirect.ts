/** Returns `value` only when it is a same-origin path; otherwise `fallback`. Prevents open redirects. */
export function safeLocalPath(value: string | null | undefined, fallback = '/'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return fallback;
  try {
    const url = new URL(value, 'http://local.invalid');
    if (url.origin !== 'http://local.invalid') return fallback;
  } catch {
    return fallback;
  }
  return value;
}

export function loginPath(next?: string): string {
  const local = safeLocalPath(next, '/');
  return local === '/' ? '/login' : `/login?next=${encodeURIComponent(local)}`;
}
