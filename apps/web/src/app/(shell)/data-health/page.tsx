// data-health/page.tsx — the thin App Router route for the Data Health destination. All behavior lives in the
// feature slice (features/data-health); this file only mounts its public component inside the (shell) chrome.
import { DataHealthPage } from "@/features/data-health";

export default function Page() {
  return <DataHealthPage />;
}
