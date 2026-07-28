// crm-sync/page.tsx — the thin App Router route for the CRM sync destination. All behaviour lives in the
// feature slice (features/crm-sync); this file only mounts its public component inside the (shell) chrome.
import { CrmSyncPage } from "@/features/crm-sync";

export default function Page() {
  return <CrmSyncPage />;
}
