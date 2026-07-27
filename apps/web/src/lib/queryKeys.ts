// queryKeys.ts — TanStack Query keys for reads that are NOT owned by a single feature.
//
// Feature-local keys live in `features/<name>/keys.ts`; these are the handful the app shell and a feature both
// touch, so neither can own them. The credit balance is the clear case: the top-bar pill and the prospect
// bulk bar read the same endpoint, and before this they each kept their own copy of the number and re-fetched
// independently on a window event. One key means one request and one value — they cannot drift.
export const sharedKeys = {
  /** The tenant's reveal-credit balance (`GET /credits/balance`). Read by the top-bar pill and the bulk bar. */
  creditBalance: () => ["credits", "balance"] as const,
  /** The top-bar bell's feed (`GET /notifications`). */
  notifications: () => ["notifications", "list"] as const,
  /** The per-workspace Data Health rollup (`GET /home/data-quality`) — the Home card and the Data Health
   *  page read the SAME endpoint, so they share one entry rather than each fetching it. */
  dataQuality: () => ["data-quality", "rollup"] as const,
  /** The Data Health trend series (`GET /home/data-quality/history`), read by the same two surfaces. */
  dataQualityTrend: () => ["data-quality", "history"] as const,
};
