// system-health/page.tsx — the thin App Router route for the System health view. Behavior lives in the feature
// slice (features/system-health); this file only mounts its public component inside the (shell) chrome.
import { SystemHealthPage } from "@/features/system-health";

export default function Page() {
  return <SystemHealthPage />;
}
