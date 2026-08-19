// InboxPage - the Inbox destination (11 §4.4): a Tabs switch between the unified reply threads and tasks.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { InboxPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** InboxPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <InboxPage />
  </Page>
);
