// trust-abuse/page.tsx — the thin App Router route for the Trust & abuse cockpit. Behavior lives in the feature
// slice (features/trust-abuse); this file only mounts its public component inside the (shell) chrome.
import { TrustAbusePage } from "@/features/trust-abuse";

export default function Page() {
  return <TrustAbusePage />;
}
