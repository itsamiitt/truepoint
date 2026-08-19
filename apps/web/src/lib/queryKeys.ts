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
  // ── Shell chrome reads (perf-audit P3.5). These were raw useEffect fetches outside the query cache, so
  // they re-fired on every hard load with no dedup, no staleTime, and no cache — four requests of the ~8
  // the chrome issued before any route data. As queries they dedupe, cache across remounts, and stop
  // re-paying on navigation. All change rarely; switching org/workspace reloads the whole shell anyway.
  /** The caller's organizations (GET /orgs on the auth origin) — the org switcher. */
  orgs: () => ["shell", "orgs"] as const,
  /** The caller's reachable workspaces (`GET /workspaces`) — the workspace switcher. */
  workspaces: () => ["shell", "workspaces"] as const,
  /** The workspace's teams (`GET /teams`, the M15 seam) — the team switcher. */
  teams: () => ["shell", "teams"] as const,
  /** The tenant's active announcements (`GET /announcements/active`) — the banner. */
  announcements: () => ["shell", "announcements"] as const,
};
