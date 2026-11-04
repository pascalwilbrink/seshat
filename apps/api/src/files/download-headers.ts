import { DEFAULT_MIME_TYPE } from './file-name.js';

const FALLBACK_NAME = 'download';

// Types a browser could execute or render actively. They are still sent as attachments, but never under their own type.
const ACTIVE_TYPES = new Set([
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
  'application/xml',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/css',
  'application/pdf',
  'text/cache-manifest',
]);

/** The stored (already sanitized) MIME type, or `application/octet-stream` for anything that could render actively. */
export function safeDownloadContentType(stored: unknown): string {
  if (typeof stored !== 'string') return DEFAULT_MIME_TYPE;
  const mime = stored.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mime) || mime.length > 255) return DEFAULT_MIME_TYPE;
  if (ACTIVE_TYPES.has(mime) || mime.endsWith('+xml')) return DEFAULT_MIME_TYPE;
  return mime;
}

// Everything that could end a quoted string, a header line or smuggle a path: controls, DEL, line/paragraph
// separators, bidi controls, BOM and zero-width characters, quotes, backslash, slashes and `%`.
const UNSAFE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u2028-\\u202e\\u2066-\\u2069\\ufeff"\\\\/%;]', 'g');

/** `attachment; filename="<ascii fallback>"; filename*=UTF-8''<percent-encoded name>` (RFC 6266 / 5987). */
export function attachmentDisposition(name: unknown): string {
  let clean = typeof name === 'string' ? name.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '_').replace(UNSAFE, '_').trim() : '';
  if (clean === '' || /^\.+$/.test(clean)) clean = FALLBACK_NAME;
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_').replace(/\s+/g, ' ');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
