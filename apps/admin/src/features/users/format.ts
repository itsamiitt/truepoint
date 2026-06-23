// format.ts — small pure presentation helper for the Users area (status → badge tone). Pure + DOM-free so it
// is unit-testable and shared across the slice. Mirrors the tenants slice's statusTone mapping.
import type { StatusTone } from "@leadwolf/ui";

/** Map a user lifecycle status to a monochrome badge tone (color is the only status signal). */
export function statusTone(status: string): StatusTone {
  switch (status) {
    case "active":
      return "success";
    case "pending":
    case "invited":
      return "warning";
    case "suspended":
    case "removed":
    case "disabled":
      return "danger";
    default:
      return "muted";
  }
}
