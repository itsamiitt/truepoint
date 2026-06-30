// computeQuality.ts — v1 survivorship quality score for the knowledge-DB projector (prospect-database-platform
// I1 / Phase 05; audit P10). PURE + side-effect-free: given a golden cluster's evidence summary, produce a 0..100
// data-quality score (the column carries a 0..100 CHECK). v1 is a CLUSTER-LEVEL heuristic (corroboration +
// freshness); the full ATTRIBUTE-LEVEL survivorship with per-field field_provenance (source-priority -> recency ->
// frequency -> completeness -> confidence) is the next iteration — documented temporary scope, not a shortcut.

export interface ClusterQualityInput {
  /** Number of source_records resolved to this cluster (corroboration). */
  evidenceCount: number;
  /** The newest evidence's ingest time (freshness), or null. */
  latestIngestedAt: Date | null;
  /** Injected clock (keeps the function pure + testable). */
  now: Date;
}

/**
 * Score = base 50, +10 per corroborating source beyond the first (capped at +30), minus up to -20 as the newest
 * evidence ages past 180 days (-2 per 30 days). Clamped to 0..100. A cluster with no evidence scores 0.
 */
export function computeClusterQualityScore(input: ClusterQualityInput): number {
  if (input.evidenceCount <= 0) return 0;
  const corroboration = Math.min(30, (input.evidenceCount - 1) * 10);
  let freshnessPenalty = 0;
  if (input.latestIngestedAt) {
    const ageDays = (input.now.getTime() - input.latestIngestedAt.getTime()) / 86_400_000;
    if (ageDays > 180) freshnessPenalty = Math.min(20, Math.round((ageDays - 180) / 30) * 2);
  }
  return Math.max(0, Math.min(100, 50 + corroboration - freshnessPenalty));
}
