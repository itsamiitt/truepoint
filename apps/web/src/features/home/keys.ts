// keys.ts — the home feature's TanStack Query key factory. Single source so every hook and any mutation that
// invalidates a cockpit read touches the SAME keys and the cache never fragments.
export const homeKeys = {
  all: ["home"] as const,
  /** The cockpit summary (`GET /home/summary`). One entry; the shell and the page share it. */
  summary: () => ["home", "summary"] as const,
};
