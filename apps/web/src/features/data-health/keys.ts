// keys.ts — the duplicate-review feature's TanStack Query key factory (import-redesign 11 §8.2 pattern, mirroring
// features/import/keys.ts). Single source so the merge-preview query + the merge mutation read/invalidate the
// SAME keys and the cache never fragments.
export const duplicateKeys = {
  all: ["duplicates"] as const,
  /** One survivor↔loser merge preview (the review drawer's field matrix + child impact). */
  mergePreview: (survivorId: string, loserId: string) =>
    ["duplicates", "merge-preview", survivorId, loserId] as const,
  /** The workspace's auto-flagged duplicate pairs (the review queue). */
  pairs: () => ["duplicates", "pairs"] as const,
  /** The per-tenant retention-engine run audit. */
  retentionRuns: () => ["duplicates", "retention-runs"] as const,
  /** The per-workspace freshness re-verification runs. */
  reverificationRuns: () => ["duplicates", "reverification-runs"] as const,
};
