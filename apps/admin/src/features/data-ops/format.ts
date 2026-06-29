// format.ts — pure presentation helpers for the Data-Ops Overview. Mirrors the Imports slice's formatInt so the
// KPI tiles read identically across the console.

/** Thousands-grouped integer for the KPI tiles (e.g. 12,840). */
export function formatInt(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Micro-credits (1e6 = 1 credit) → a compact credit figure for the run tables. */
export function formatCredits(micros: number): string {
  return (micros / 1_000_000).toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** A whole-number percentage n/d for the fleet tables ("—" when the denominator is 0). */
export function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : "—";
}

/** A compact local date-time for created/run columns (client-rendered; "use client" pages only). */
export function shortDate(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
