// ReportsPage - the Reports destination (11 §4.5 MVP slice): a Tabs dashboard switcher over six sections (Pipeline funnel · Credit usage · Sending & deliverability · Team activity · Data health · Lead score & intent).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ReportsPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ReportsPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <ReportsPage />
  </Page>
);
