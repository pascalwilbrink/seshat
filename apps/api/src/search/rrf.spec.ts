import { describe, expect, it } from 'vitest';
import { RRF_K, fuseRankings, rrfContribution } from './rrf.js';

describe('reciprocal rank fusion', () => {
  it('uses k = 60 and sums 1/(60 + rank) over the rankings an item appears in', () => {
    expect(RRF_K).toBe(60);
    expect(rrfContribution(1)).toBe(1 / 61);
    const [both, onlyVector] = fuseRankings(
      [
        { kind: 'chunk', source: 'vector', ids: ['a', 'b'] },
        { kind: 'chunk', source: 'keyword', ids: ['b'] },
      ],
      { limit: 10 },
    );
    expect(both).toEqual({ kind: 'chunk', id: 'b', vectorRank: 2, keywordRank: 1, score: 1 / 62 + 1 / 61 });
    expect(onlyVector).toEqual({ kind: 'chunk', id: 'a', vectorRank: 1, keywordRank: null, score: 1 / 61 });
  });

  it('merges chunks and memories into one list without duplicates; equal ids of different kinds stay separate', () => {
    const fused = fuseRankings(
      [
        { kind: 'chunk', source: 'vector', ids: ['x'] },
        { kind: 'chunk', source: 'keyword', ids: ['x'] },
        { kind: 'memory', source: 'vector', ids: ['x', 'y'] },
        { kind: 'memory', source: 'keyword', ids: ['y'] },
      ],
      { limit: 10 },
    );
    expect(fused.map((f) => `${f.kind}:${f.id}`)).toEqual(['chunk:x', 'memory:y', 'memory:x']);
  });

  it('breaks ties deterministically: better rank, then chunk before memory, then id', () => {
    const rankings = [
      { kind: 'memory' as const, source: 'vector' as const, ids: ['m2', 'm1'] },
      { kind: 'chunk' as const, source: 'vector' as const, ids: ['c2', 'c1'] },
      { kind: 'chunk' as const, source: 'keyword' as const, ids: ['c1'] },
    ];
    const order = (r: typeof rankings) => fuseRankings(r, { limit: 10 }).map((f) => f.id);
    // c1 has both rankings; rank-1 items tie on score and then on kind/id; rank-2 items follow.
    expect(order(rankings)).toEqual(['c1', 'c2', 'm2', 'm1']);
    expect(order([...rankings].reverse())).toEqual(['c1', 'c2', 'm2', 'm1']);
    const tie = fuseRankings(
      [
        { kind: 'chunk', source: 'vector', ids: ['b'] },
        { kind: 'chunk', source: 'keyword', ids: ['a'] },
      ],
      { limit: 10 },
    );
    expect(tie.map((f) => f.id)).toEqual(['a', 'b']);
  });

  it('applies minScore to fused scores and cuts to limit only after fusion', () => {
    const rankings = [
      { kind: 'chunk' as const, source: 'vector' as const, ids: ['a', 'b', 'c'] },
      { kind: 'chunk' as const, source: 'keyword' as const, ids: ['c', 'a'] },
    ];
    expect(fuseRankings(rankings, { limit: 10 }).map((f) => f.id)).toEqual(['a', 'c', 'b']);
    // c is vector rank 3 but keyword rank 1: it outranks b, which a pre-fusion cut at 2 would have kept.
    expect(fuseRankings(rankings, { limit: 2 }).map((f) => f.id)).toEqual(['a', 'c']);
    expect(fuseRankings(rankings, { limit: 10, minScore: 0.03 }).map((f) => f.id)).toEqual(['a', 'c']);
    expect(fuseRankings(rankings, { limit: 10, minScore: 1 })).toEqual([]);
  });

  it('returns nothing for no rankings', () => {
    expect(fuseRankings([], { limit: 5 })).toEqual([]);
  });
});
