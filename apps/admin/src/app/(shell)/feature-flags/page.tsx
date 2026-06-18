// feature-flags/page.tsx — thin App Router route for the platform feature-flags screen. All behavior lives
// in the feature slice (features/feature-flags); this file only mounts its public component. The admin
// shell (a sibling unit) provides the surrounding (shell) chrome + staff auth.
import { FeatureFlagsPage } from "../../../features/feature-flags";

export default function Page() {
  return <FeatureFlagsPage />;
}
