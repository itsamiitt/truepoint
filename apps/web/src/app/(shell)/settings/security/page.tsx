// Settings ▸ User ▸ Security — mounts the settings-user slice's Security panel (12 §2). The mutations live on
// the auth origin; this panel is read-only status + deep links.
import { SecurityPanel } from "@/features/settings-user";

export default function SecuritySettingsRoute() {
  return <SecurityPanel />;
}
