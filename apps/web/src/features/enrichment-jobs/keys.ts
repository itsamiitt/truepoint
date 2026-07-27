// keys.ts — the enrichment-jobs feature's TanStack Query key factory. Single source so the list, the drawer
// detail and any mutation read/invalidate the SAME keys and the cache never fragments.
export const enrichmentJobKeys = {
  all: ["enrichment-jobs"] as const,
  /** The workspace's enrichment jobs (`GET /enrichment/jobs`). Polls while any row is in flight. */
  list: () => ["enrichment-jobs", "list"] as const,
  /** One job's fresh detail (`GET /enrichment/jobs/:jobId`) — the drawer's read. */
  detail: (jobId: string) => ["enrichment-jobs", "detail", jobId] as const,
};
