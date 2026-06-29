// data-ops/verification/page.tsx — thin App Router route for the cross-tenant freshness re-verification monitor
// (database-management-research 08/10, Phase 2 read slice). Behavior lives in features/data-ops; the (shell)
// chrome + staff adminGate wrap it; the server gates GET /admin/data/verification/runs on the data:read capability.
import { VerificationRunsPage } from "@/features/data-ops";

export default function Page() {
  return <VerificationRunsPage />;
}
