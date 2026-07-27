// keys.ts — the home feature's TanStack Query key factory. Single source so every hook and any mutation that
// invalidates a cockpit read touches the SAME keys and the cache never fragments.
export const homeKeys = {
  all: ["home"] as const,
  /** The cockpit summary (`GET /home/summary`). One entry; the shell and the page share it. */
  summary: () => ["home", "summary"] as const,
  /** The per-workspace Data Health rollup (`GET /home/data-quality`). */
  dataQuality: () => ["home", "data-quality"] as const,
  /** The Data Health trend series (`GET /home/data-quality/history`). */
  dataQualityTrend: () => ["home", "data-quality", "history"] as const,
};
