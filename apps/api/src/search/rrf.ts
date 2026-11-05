
/** Reciprocal rank fusion constant (score contribution of a ranking position is 1 / (RRF_K + rank)). */
export const RRF_K = 60;

export type CandidateKind = 'chunk' | 'memory';

/** A candidate identity with its 1-based position in each ranking it appeared in (null when absent). */
export interface RankedCandidate {
  kind: CandidateKind;
  id: string;
  vectorRank: number | null;
  keywordRank: number | null;
}

export interface FusedCandidate extends RankedCandidate {
  score: number;
}

export const rrfContribution = (rank: number): number => 1 / (RRF_K + rank);

/** One input ranking: ids in rank order (best first). Rank is position + 1. */
export interface Ranking {
  kind: CandidateKind;
  source: 'vector' | 'keyword';
  ids: readonly string[];
}

/**
 * Fuses rankings with reciprocal rank fusion: score = sum over rankings of 1 / (60 + rank). Items are identified by
 * kind and id, so one item present in both of its rankings is one result and ids of different kinds never collide.
 * Output order is fully deterministic: score descending, then the better (smaller) of its ranks, then chunks before
 * memories, then id. `minScore` applies to the fused score; the cut to `limit` happens after it.
 */
export function fuseRankings(rankings: readonly Ranking[], options: { limit: number; minScore?: number | undefined }): FusedCandidate[] {
  const byKey = new Map<string, RankedCandidate>();
  for (const ranking of rankings) {
    ranking.ids.forEach((id, index) => {
      const key = `${ranking.kind}:${id}`;
      let item = byKey.get(key);
      if (!item) {
        item = { kind: ranking.kind, id, vectorRank: null, keywordRank: null };
        byKey.set(key, item);
      }
      const rank = index + 1;
      if (ranking.source === 'vector') item.vectorRank ??= rank;
      else item.keywordRank ??= rank;
    });
  }
  const fused: FusedCandidate[] = [...byKey.values()].map((c) => ({
    ...c,
    // Fixed addition order (vector, then keyword) keeps equal rank pairs bit-identical.
    score: (c.vectorRank === null ? 0 : rrfContribution(c.vectorRank)) + (c.keywordRank === null ? 0 : rrfContribution(c.keywordRank)),
  }));
  const bestRank = (c: RankedCandidate): number => Math.min(c.vectorRank ?? Infinity, c.keywordRank ?? Infinity);
  fused.sort(
    (a, b) =>
      b.score - a.score ||
      bestRank(a) - bestRank(b) ||
      (a.kind === b.kind ? 0 : a.kind === 'chunk' ? -1 : 1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const min = options.minScore;
  const kept = min === undefined ? fused : fused.filter((c) => c.score >= min);
  return kept.slice(0, options.limit);
}

