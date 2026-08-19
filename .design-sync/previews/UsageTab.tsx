// UsageTab - the billing hub's Usage tab: keyset-paginated, filterable credit-usage history with a "Load more" cursor and CSV export, on the foundation DataTable.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { UsageTab } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** UsageTab with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <UsageTab />
  </Page>
);
