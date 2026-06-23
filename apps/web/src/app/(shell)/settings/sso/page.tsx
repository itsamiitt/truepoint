// Settings ▸ Tenant ▸ Single sign-on — mounts the tenant SSO (SAML/OIDC) config panel (settings-tenant slice).
// The thin route only mounts the public component inside the (shell) chrome; behavior lives in the slice.
import { SsoConfigPanel } from "@/features/settings-tenant";

export default function SsoSettingsRoute() {
  return <SsoConfigPanel />;
}
