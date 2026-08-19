// NotificationsPage - the full notification history (G-NTF-1): a keyset-paginated list with per-item + bulk mark-read and "Load more".
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { NotificationsPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** NotificationsPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <NotificationsPage />
  </Page>
);
