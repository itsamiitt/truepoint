// plans/page.tsx — the thin App Router route for the plan-template catalog. Behavior lives in the feature
// slice (features/plans); this file only mounts its public component inside the (shell) chrome.
import { PlansPage } from "@/features/plans";

export default function Page() {
  return <PlansPage />;
}
