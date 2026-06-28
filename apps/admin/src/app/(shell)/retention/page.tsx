// retention/page.tsx — thin App Router route for the global retention-policy screen. All behavior lives in
// the feature slice (features/retention); this file only mounts its public component. The admin shell (a
// sibling unit) provides the surrounding (shell) chrome + staff auth.
import { RetentionPoliciesPage } from "../../../features/retention";

export default function Page() {
  return <RetentionPoliciesPage />;
}
