// retention/page.tsx — thin App Router route for the retention surface (Policies + Runs tabs). All behavior
// lives in the feature slice (features/retention); this file only mounts its public Tabs host. The admin shell
// (a sibling unit) provides the surrounding (shell) chrome + staff auth.
import { RetentionPage } from "../../../features/retention";

export default function Page() {
  return <RetentionPage />;
}
