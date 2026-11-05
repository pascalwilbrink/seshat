import { describe, expect, it } from 'vitest';
import { memoryContentHash, normalizeMemoryContent } from './memory-content.js';

describe('memory content normalization', () => {
  it('trims and collapses all whitespace runs', () => {
    expect(normalizeMemoryContent('  a \t b\n\n c d  ')).toBe('a b c d');
  });
  it('applies Unicode NFC', () => {
    expect(normalizeMemoryContent('é')).toBe('é');
  });
  it('preserves case and punctuation', () => {
    expect(normalizeMemoryContent('Use TLS.')).toBe('Use TLS.');
  });
});

describe('memory content hash', () => {
  it('is a lowercase 64-char hex SHA-256', () => {
    expect(memoryContentHash('x')).toMatch(/^[0-9a-f]{64}$/);
  });
  it('is equal for whitespace and Unicode-equivalent content', () => {
    expect(memoryContentHash('café  au\nlait')).toBe(memoryContentHash(' café au lait '));
  });
  it('keeps distinct case distinct', () => {
    expect(memoryContentHash('Use TLS')).not.toBe(memoryContentHash('use tls'));
  });
  it('keeps different words distinct', () => {
    expect(memoryContentHash('a b')).not.toBe(memoryContentHash('ab'));
  });
});
