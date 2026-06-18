// format.ts — pure presentation helpers for the System health area. DOM-free + unit-testable.
import type { StatusTone } from "@leadwolf/ui";
import type { ServiceStatus } from "./types";

/** Map a service status to a monochrome badge tone (color is the only status signal). */
export function serviceTone(status: ServiceStatus): StatusTone {
  switch (status) {
    case "up":
      return "success";
    case "degraded":
      return "warning";
    case "down":
      return "danger";
    default:
      return "muted";
  }
}

/** Title-case a service name for display (api → API, otherwise capitalize). */
export function serviceLabel(name: string): string {
  if (name === "api") return "API";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
