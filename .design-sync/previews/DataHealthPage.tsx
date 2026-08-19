// DataHealthPage - the Data Health destination: a Tabs switcher (Overview · Re-verification activity · Retention) over the per-workspace data-quality rollups — headline metrics, per-field coverage, the freshness trend, and the email/phone verification breakdown — plus the daily re-verification activity and the tenant-wide...
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { DataHealthPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** DataHealthPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <DataHealthPage />
  </Page>
);
