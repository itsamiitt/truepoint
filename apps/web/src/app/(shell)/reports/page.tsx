// (shell)/reports/page.tsx — the thin App Router route for the Reports destination (11 §4.5). All behavior
// lives in the feature slice (features/reports); this file only mounts its public component inside the
// (shell) chrome.
import { ReportsPage } from "@/features/reports";

export default function ReportsRoute() {
  return <ReportsPage />;
}
