// (shell)/settings/compliance/page.tsx — the thin App Router route for Compliance & data (12 §4, 08). All
// behavior lives in the feature slice (features/settings-compliance); this file only mounts its public
// component inside the (shell) chrome.
import { CompliancePage } from "@/features/settings-compliance";

export default function ComplianceRoute() {
  return <CompliancePage />;
}
