// SettingsNav - the settings rail, grouped by SCOPE rather than by feature: what is yours (user), what is
// the workspace's, and what is the tenant's. That grouping is the point - it tells you, before you click,
// whose data a change will affect.
import { SettingsNav } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** The full rail. Height is set to the nav's own length so nothing is clipped mid-label. */
export const Loaded = () => (
  <Page height={720}>
    <SettingsNav />
  </Page>
);
