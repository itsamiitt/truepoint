// SettingsScopeLayout - the two-column settings frame: the scope nav on the left, the active panel on the
// right. Every settings destination renders inside it.
import { SettingsScopeLayout, SettingsPlaceholder } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** The layout framing a settings panel. */
export const Framed = () => (
  <Page height={700}>
    <SettingsScopeLayout>
      <SettingsPlaceholder
        title="Notifications"
        description="Choose which events reach you in-app and by email."
      />
    </SettingsScopeLayout>
  </Page>
);
