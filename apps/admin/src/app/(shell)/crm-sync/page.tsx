// crm-sync/page.tsx — the thin App Router route for the staff CRM-sync monitor. Behaviour lives in the
// feature slice (features/crm-sync); this file only mounts its public component inside the (shell) chrome.
import { CrmSyncMonitorPage } from "@/features/crm-sync";

export default function Page() {
  return <CrmSyncMonitorPage />;
}
