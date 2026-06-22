// prospect/page.tsx — the thin App Router route for the Prospect surface. All behavior lives in the feature
// slice (features/prospect); this file only mounts its public component inside the (shell) chrome.
import { ProspectPage } from "@/features/prospect";

// The Prospect surface reads its filter/search state from the URL (useProspectSearch → useSearchParams), so
// it is rendered dynamically rather than statically prerendered (avoids the prerender CSR bailout).
export const dynamic = "force-dynamic";

export default function ProspectRoute() {
  return <ProspectPage />;
}
