// provider-configs/page.tsx — thin App Router route for the data-providers screen. All behavior lives in
// the feature slice (features/provider-configs); this file only mounts its public component inside the
// admin (shell) chrome the sibling shell unit provides.
import { ProviderConfigsPage } from "../../../features/provider-configs";

export default function Page() {
  return <ProviderConfigsPage />;
}
