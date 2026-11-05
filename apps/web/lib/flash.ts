const KEY = 'seshat:flash';

/** Queues a success message that survives one full-page navigation. Never put credentials or user data in it. */
export function queueFlash(message: string): void {
  try {
    window.sessionStorage.setItem(KEY, message);
  } catch {
    // Storage can be unavailable; the navigation still works without the toast.
  }
}

/** Reads and clears the queued message, if any. */
export function takeFlash(): string | null {
  try {
    const message = window.sessionStorage.getItem(KEY);
    if (message !== null) window.sessionStorage.removeItem(KEY);
    return message;
  } catch {
    return null;
  }
}
