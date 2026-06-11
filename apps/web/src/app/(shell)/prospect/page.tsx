// prospect/page.tsx — the thin App Router route for the Prospect surface. All behavior lives in the feature
// slice (features/prospect); this file only mounts its public component inside the (shell) chrome.
import { ProspectPage } from "@/features/prospect";

export default function ProspectRoute() {
  return <ProspectPage />;
}
