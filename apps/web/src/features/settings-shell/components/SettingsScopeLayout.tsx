// SettingsScopeLayout.tsx — the two-column Settings shell: the scope nav on the left, the active panel on the
// right. Used by app/(shell)/settings/layout.tsx to wrap every /settings/* route. Layout only.
import type { ReactNode } from "react";
import { SettingsNav } from "./SettingsNav";

export function SettingsScopeLayout({ children }: { children: ReactNode }) {
  return (
    <div className="tp-settings-shell">
      <SettingsNav />
      <div className="tp-settings-panel">{children}</div>
    </div>
  );
}
