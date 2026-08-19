// ImportJobsHistoryPage - the durable import history dashboard (import-redesign 11 §2, S-U2).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ImportJobsHistoryPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ImportJobsHistoryPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <ImportJobsHistoryPage />
  </Page>
);
