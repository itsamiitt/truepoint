// SettingsPlaceholder - the honest stand-in for a settings panel that is not built yet. It names the
// surface and says what it will do, rather than showing an empty page or a fake form.
import { SettingsPlaceholder } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** With a description - the usual form. */
export const Described = () => (
  <Frame>
    <SettingsPlaceholder
      title="Audit log"
      description="A searchable record of every change made in this workspace. Coming in a later release."
    />
  </Frame>
);

/** Title only, when there is nothing honest to add yet. */
export const TitleOnly = () => (
  <Frame>
    <SettingsPlaceholder title="Data residency" />
  </Frame>
);
