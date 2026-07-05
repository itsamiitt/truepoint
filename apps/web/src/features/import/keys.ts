// keys.ts — the import feature's TanStack Query key factory (import-redesign 11 §8.2). Single source so every
// hook + mutation reads/invalidates the SAME keys and the cache never fragments. The history list is ONE
// infinite-query entry (all keyset pages live under it — pageParam is the cursor); a mutation invalidates
// `all` to refresh both the list and any open detail.
export const importKeys = {
  all: ["imports"] as const,
  /** The durable history list — a single infinite-query entry holding every loaded keyset page. */
  list: () => ["imports", "list"] as const,
  /** One durable job's detail (the drawer + the job page share this entry). */
  detail: (jobId: string) => ["imports", "detail", jobId] as const,
};
