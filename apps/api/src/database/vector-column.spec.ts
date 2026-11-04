import { describe, expect, it } from 'vitest';
import { MAX_VECTOR_DIMENSION, vectorColumn, vectorTransformer } from './vector-column.js';

describe('vectorColumn', () => {
  it('declares a vector(n) column with the supplied dimension', () => {
    const o = vectorColumn(3);
    expect(o.type).toBe('vector');
    expect(o.length).toBe(3);
    expect(vectorColumn(1536).length).toBe(1536);
  });

  it.each([0, -1, 1.5, NaN, Infinity, MAX_VECTOR_DIMENSION + 1])('rejects dimension %s', (d) => {
    expect(() => vectorColumn(d)).toThrow(RangeError);
    expect(() => vectorTransformer(d)).toThrow(RangeError);
  });
});

describe('vectorTransformer', () => {
  const t = vectorTransformer(3);
  const to = (v: unknown) => (t.to as (v: unknown) => unknown)(v);
  const from = (v: unknown) => (t.from as (v: unknown) => unknown)(v);

  it('passes valid vectors through on write', () => {
    expect(to([1, -2.5, 0])).toEqual([1, -2.5, 0]);
  });

  it('keeps null and undefined on write; returns null on read', () => {
    expect(to(null)).toBeNull();
    expect(to(undefined)).toBeUndefined();
    expect(from(null)).toBeNull();
    expect(from(undefined)).toBeNull();
  });

  it('rejects wrong lengths without leaking values', () => {
    expect(() => to([1, 2])).toThrow('Vector must have 3 dimensions, got 2');
    expect(() => to([1, 2, 3, 4])).toThrow(RangeError);
  });

  it.each([[NaN], [Infinity], [-Infinity], ['1'], [null]])('rejects non-finite or non-number element %s', (bad) => {
    expect(() => to([1, 2, bad])).toThrow('Vector values must be finite numbers');
  });

  it('rejects non-arrays', () => {
    expect(() => to('[1,2,3]')).toThrow(TypeError);
    expect(() => to({})).toThrow(TypeError);
  });

  it('reads arrays and pgvector text as number[]', () => {
    expect(from([1, 2, 3])).toEqual([1, 2, 3]);
    expect(from('[1,2.5,3]')).toEqual([1, 2.5, 3]);
    expect(from('[]')).toEqual([]);
  });
});
