// AnnouncementBanner - the in-app announcement banner (13a Area 10): renders the active announcements for the signed-in tenant at the top of the app shell, with a per-announcement dismiss persisted in localStorage so a dismissed banner stays gone across reloads.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { AnnouncementBanner } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** AnnouncementBanner with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <AnnouncementBanner />
  </Page>
);
