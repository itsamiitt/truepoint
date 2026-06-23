// audit-log/page.tsx — the thin App Router route for the platform audit-log viewer. Behavior lives in the
// feature slice (features/audit-log); this file only mounts its public component inside the (shell) chrome.
import { AuditLogPage } from "@/features/audit-log";

export default function Page() {
  return <AuditLogPage />;
}
