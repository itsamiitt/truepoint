// Settings ▸ Tenant ▸ Domains & SCIM — mounts the identity-provisioning panel (settings-tenant slice). The
// thin route only mounts the public component inside the (shell) chrome; behavior lives in the slice.
import { IdentityPanel } from "@/features/settings-tenant";

export default function IdentitySettingsRoute() {
  return <IdentityPanel />;
}
