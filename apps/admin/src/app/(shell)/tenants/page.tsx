// tenants/page.tsx — the thin App Router route for the Tenants directory. Behavior lives in the feature slice
// (features/tenants); this file only mounts its public component inside the (shell) chrome.
import { TenantsPage } from "@/features/tenants";

export default function Page() {
  return <TenantsPage />;
}
