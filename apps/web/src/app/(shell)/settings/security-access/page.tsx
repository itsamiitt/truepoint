// Settings ▸ Tenant ▸ Security & access — mounts the tenant auth-policy panel (settings-tenant slice). The
// thin route only mounts the public component inside the (shell) chrome; behavior lives in the slice.
import { SecurityAccessPanel } from "@/features/settings-tenant";

export default function SecurityAccessSettingsRoute() {
  return <SecurityAccessPanel />;
}
