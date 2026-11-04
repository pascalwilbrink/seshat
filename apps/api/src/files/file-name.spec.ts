import { describe, expect, it } from 'vitest';
import { extensionOf, sanitizeFileName, sanitizeMimeType } from './file-name.js';

describe('sanitizeFileName', () => {
  it.each([
    ['report.pdf', 'report.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Users\\me\\secret.txt', 'secret.txt'],
    ['a/b\\c/d.md', 'd.md'],
    ['  spaced name.txt  ', 'spaced name.txt'],
    ['evil\u0000name\r\n.txt', 'evilname.txt'],
    ['rtl\u202etxt.exe', 'rtltxt.exe'],
    ['..', 'file'],
    ['.', 'file'],
    ['', 'file'],
    ['dir/', 'file'],
    ['\u0007\u0008', 'file'],
  ])('%j gives %j', (raw, expected) => {
    expect(sanitizeFileName(raw)).toBe(expected);
  });

  it('falls back for non-strings and caps at 255 characters', () => {
    expect(sanitizeFileName(undefined)).toBe('file');
    expect(Array.from(sanitizeFileName('x'.repeat(400))).length).toBe(255);
    expect(Array.from(sanitizeFileName('\u{1F600}'.repeat(300))).length).toBe(255);
  });
});

describe('extensionOf', () => {
  it('lowercases a plain extension and rejects odd ones', () => {
    expect(extensionOf('a.TXT')).toBe('txt');
    expect(extensionOf('archive.tar.GZ')).toBe('gz');
    expect(extensionOf('.bashrc')).toBeNull();
    expect(extensionOf('noext')).toBeNull();
    expect(extensionOf('trailing.')).toBeNull();
    expect(extensionOf('a.b c')).toBeNull();
    expect(extensionOf(`a.${'x'.repeat(33)}`)).toBeNull();
  });
});

describe('sanitizeMimeType', () => {
  it('keeps a plain type/subtype lowercased and defaults everything else', () => {
    expect(sanitizeMimeType('Text/Plain')).toBe('text/plain');
    expect(sanitizeMimeType('application/vnd.api+json')).toBe('application/vnd.api+json');
    expect(sanitizeMimeType('text/html; charset=x')).toBe('application/octet-stream');
    expect(sanitizeMimeType('nonsense')).toBe('application/octet-stream');
    expect(sanitizeMimeType(undefined)).toBe('application/octet-stream');
  });
});
