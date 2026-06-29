// data-ops/page.tsx — thin App Router route for the Data-management control panel (the Data-Ops Overview). All
// behavior lives in the feature slice (features/data-ops); this file only mounts its public component. The admin
// shell (a sibling unit) provides the surrounding (shell) chrome + staff auth (adminGate); the server additionally
// gates GET /admin/data/* on the data:read capability.
import { DataOpsOverviewPage } from "../../../features/data-ops";

export default function Page() {
  return <DataOpsOverviewPage />;
}
