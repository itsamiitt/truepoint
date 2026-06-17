// format.ts — small pure presentation helpers for the Tenants area (status → badge tone, dates, numbers).
// Pure + DOM-free so they are unit-testable and shared across the list + detail views.
import type { StatusTone } from "@leadwolf/ui";

/** Map a tenant/member lifecycle status to a monochrome badge tone (color is the only status signal). */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case "active":
      return "success";
    case "pending":
    case "invited":
      return "warning";
    case "suspended":
    case "removed":
      return "danger";
    default:
      return "muted";
  }
}

/** A compact, locale-stable date (YYYY-MM-DD) from an ISO string; "—" when absent/invalid. */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(0, 10);
}

/** Thousands-separated integer. */
export function formatInt(n: number): string {
  return n.toLocaleString("en-US");
}
