// Settings layout — wraps every /settings/* route in the 4-scope shell (scope nav + panel). Route pages render
// their own content into the panel; the scope nav comes from the central navConfig (SETTINGS_NAV).
import { SettingsScopeLayout } from "@/features/settings-shell";
import type { ReactNode } from "react";

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return <SettingsScopeLayout>{children}</SettingsScopeLayout>;
}
