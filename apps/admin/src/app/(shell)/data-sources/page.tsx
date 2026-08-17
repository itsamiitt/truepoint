// data-sources/page.tsx — thin App Router route for the origin-fleet screen. All behavior lives in the
// feature slice (features/data-sources); this file only mounts its public component in the shell chrome.
import { DataSourceOriginsPage } from "../../../features/data-sources";

export default function Page() {
  return <DataSourceOriginsPage />;
}
