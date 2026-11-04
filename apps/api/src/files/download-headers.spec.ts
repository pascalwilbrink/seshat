import { describe, expect, it } from 'vitest';
import { attachmentDisposition, safeDownloadContentType } from './download-headers.js';

describe('attachmentDisposition', () => {
  it('is always an attachment with an ASCII fallback and an encoded UTF-8 name', () => {
    expect(attachmentDisposition('report.txt')).toBe(`attachment; filename="report.txt"; filename*=UTF-8''report.txt`);
    const h = attachmentDisposition('Überschrift – 日本.txt');
    expect(h).toMatch(/^attachment; filename="[\x20-\x7e]*"; filename\*=UTF-8''[A-Za-z0-9%._-]+$/);
    expect(h).toContain('%C3%9C');
  });

  it('neutralizes quotes, backslashes, CR/LF and other header-injection characters', () => {
    const h = attachmentDisposition('a"b\\c\r\nSet-Cookie: x=1\u0000;.txt');
    expect(h).not.toMatch(/[\r\n\u0000]/);
    expect(h.match(/"/g)).toHaveLength(2);
    expect(h).not.toContain('\\');
    expect(h.startsWith('attachment; ')).toBe(true);
  });

  it('percent-encodes RFC 5987 specials and survives lone surrogates and empty names', () => {
    expect(attachmentDisposition("it's (a) *file*")).toContain("it%27s%20%28a%29%20%2Afile%2A");
    expect(() => attachmentDisposition('x\ud800y')).not.toThrow();
    expect(attachmentDisposition('')).toContain('filename="download"');
    expect(attachmentDisposition('..')).toContain('filename="download"');
    expect(attachmentDisposition(42)).toContain('filename="download"');
  });
});

describe('safeDownloadContentType', () => {
  it('keeps passive types and downgrades anything that could render actively', () => {
    expect(safeDownloadContentType('text/plain')).toBe('text/plain');
    expect(safeDownloadContentType('image/png')).toBe('image/png');
    for (const t of ['text/html', 'image/svg+xml', 'application/pdf', 'application/xhtml+xml', 'text/xml', 'application/rss+xml', 'text/javascript']) {
      expect(safeDownloadContentType(t)).toBe('application/octet-stream');
    }
    expect(safeDownloadContentType('TEXT/HTML')).toBe('application/octet-stream');
    expect(safeDownloadContentType('text/plain\r\nX: y')).toBe('application/octet-stream');
    expect(safeDownloadContentType(undefined)).toBe('application/octet-stream');
  });
});
