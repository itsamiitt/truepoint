// keys.ts — the reports feature's TanStack Query key factory.
//
// One key for the whole raw source (balance + usage + contacts, fetched in parallel) because that is how the
// dashboard consumes it: the range and member filters are applied client-side over the loaded sample, so they
// are NOT part of the key. When C-3.10 moves the aggregation server-side the filters become server inputs and
// belong in the key — that change is blocked on two product decisions, not on this.
export const reportKeys = {
  all: ["reports"] as const,
  /** The report's raw inputs, loaded together (the balance tile). */
  source: () => ["reports", "source"] as const,
  /** The server-aggregated counts for one filter combination — the filters ARE the key now. */
  summary: (range: string, member: string) => ["reports", "summary", range, member] as const,
};
