// keys.ts — the duplicate-review feature's TanStack Query key factory (import-redesign 11 §8.2 pattern, mirroring
// features/import/keys.ts). Single source so the merge-preview query + the merge mutation read/invalidate the
// SAME keys and the cache never fragments. The dismiss-only pair LIST is still the shipped useState hook
// (useDuplicatePairs) — only the NEW merge surface is TanStack-shaped (the slice's adoption point).
export const duplicateKeys = {
  all: ["duplicates"] as const,
  /** One survivor↔loser merge preview (the review drawer's field matrix + child impact). */
  mergePreview: (survivorId: string, loserId: string) =>
    ["duplicates", "merge-preview", survivorId, loserId] as const,
};
