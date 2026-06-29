// data-ops/quality/page.tsx — thin App Router route for the cross-tenant fleet data-quality view
// (database-management-research 10, gap G18). Behavior lives in features/data-ops; the (shell) chrome + staff
// adminGate wrap it; the server gates GET /admin/data/quality/snapshots on the data:read capability.
import { FleetQualityPage } from "@/features/data-ops";

export default function Page() {
  return <FleetQualityPage />;
}
