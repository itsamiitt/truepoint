// format.ts — pure presentation helpers for the Data-Ops Overview. Mirrors the Imports slice's formatInt so the
// KPI tiles read identically across the console.

/** Thousands-grouped integer for the KPI tiles (e.g. 12,840). */
export function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
