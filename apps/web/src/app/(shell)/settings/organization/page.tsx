// Settings ▸ Tenant ▸ Organization — mounts the tenant Organization panel (settings-tenant slice). All behavior
// lives in the feature slice; this thin route only mounts its public component inside the (shell) chrome.
import { OrganizationPanel } from "@/features/settings-tenant";

export default function OrganizationSettingsRoute() {
  return <OrganizationPanel />;
}
