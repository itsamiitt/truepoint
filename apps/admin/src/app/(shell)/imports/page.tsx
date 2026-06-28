// imports/page.tsx — thin App Router route for the cross-tenant bulk-import monitor. All behavior lives in the
// feature slice (features/imports); this file only mounts its public component. The admin shell (a sibling
// unit) provides the surrounding (shell) chrome + staff auth (adminGate).
import { ImportsMonitorPage } from "../../../features/imports";

export default function Page() {
  return <ImportsMonitorPage />;
}
