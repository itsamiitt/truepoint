// AvailabilityBadge.tsx — says whether the thing on the page actually works yet.
//
// This badge is the site's honesty mechanism. Publishing a contract and a price before the service exists is
// a deliberate positioning move (DocappPlan/06 §5, 10), but it only stays honest if a reader can never be
// confused about which half they are looking at. So the badge is required on every endpoint, dataset and plan
// — the type system makes `availability` non-optional — and it says a word, not just a colour.

import type { Availability } from "@/content/types.ts";
import { StatusBadge } from "@leadwolf/ui";

const PRESENTATION: Record<Availability, { tone: "success" | "warning" | "muted"; label: string }> =
  {
    available: { tone: "success", label: "Available" },
    beta: { tone: "warning", label: "Beta" },
    planned: { tone: "muted", label: "Planned — not callable yet" },
  };

export function AvailabilityBadge({ availability }: { availability: Availability }) {
  const { tone, label } = PRESENTATION[availability];
  return <StatusBadge tone={tone}>{label}</StatusBadge>;
}
