// data-ops/enrichment/page.tsx — thin App Router route for the cross-tenant enrichment-run monitor
// (database-management-research 08, Phase 2 read slice). Behavior lives in features/data-ops; the (shell) chrome
// + staff adminGate wrap it; the server gates GET /admin/data/enrichment/runs on the data:read capability.
import { EnrichmentRunsPage } from "@/features/data-ops";

export default function Page() {
  return <EnrichmentRunsPage />;
}
