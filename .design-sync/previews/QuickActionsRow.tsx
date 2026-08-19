// QuickActionsRow - a row of one-click deep-links into the primary workflows (New search, Import, Start sequence).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { QuickActionsRow } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** QuickActionsRow with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <QuickActionsRow />
  </Page>
);
