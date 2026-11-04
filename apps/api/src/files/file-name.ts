/** Display-name and MIME sanitizing for uploads. Client-supplied names are display data only, never paths. */

export const FILE_NAME_MAX_LENGTH = 255;
export const FILE_NAME_FALLBACK = 'file';
export const DEFAULT_MIME_TYPE = 'application/octet-stream';

// C0/C1 controls, DEL, line/paragraph separators, bidi controls and zero-width/BOM characters.
const UNSAFE_CHARS = new RegExp(
  [
    '[\\u0000-\\u001f\\u007f-\\u009f',
    '\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff]',
  ].join(''),
  'g',
);

/**
 * Removes path components (both `/` and `\` separators) and control characters, trims, caps at 255 characters and
 * falls back to a safe nonempty name (also for `.` and `..`).
 */
export function sanitizeFileName(raw: unknown): string {
  let name = typeof raw === 'string' ? raw : '';
  name = name.replace(UNSAFE_CHARS, '');
  name = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1);
  name = name.normalize('NFC').trim();
  if (/^\.+$/.test(name)) name = '';
  const chars = Array.from(name);
  if (chars.length > FILE_NAME_MAX_LENGTH) name = chars.slice(0, FILE_NAME_MAX_LENGTH).join('').trim();
  return name.length > 0 ? name : FILE_NAME_FALLBACK;
}

/** Lowercase extension of a sanitized name (`a.TXT` gives `txt`), or null when absent or not `[a-z0-9]{1,32}`. */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,32}$/.test(ext) ? ext : null;
}

/** The declared MIME type, lowercased, when it is a plain `type/subtype`; otherwise `application/octet-stream`. */
export function sanitizeMimeType(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_MIME_TYPE;
  const mime = raw.trim().toLowerCase();
  return mime.length <= 255 && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) ? mime : DEFAULT_MIME_TYPE;
}
