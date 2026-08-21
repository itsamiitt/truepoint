// keys.ts — the api-usage feature's TanStack Query key factory. Single source so the Home cockpit card and
// any future Developer-settings detail view share one cache entry rather than each fetching the window.
//
// The window is IN the key because it is a SERVER-side filter — a different `days` is a different response,
// not a different view of the same one. (Client-side-applied filters stay out of keys; the reports slice
// draws the same line.)
export const apiUsageKeys = {
  all: ["api-usage"] as const,
  /** The tenant's API usage over a window (`GET /tenants/me/api-usage?days=`). */
  window: (days: number) => ["api-usage", "window", days] as const,
};
