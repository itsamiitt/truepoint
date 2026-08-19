// DraftReviewPanel - the AI draft → review → send seam (05 §13/§16) inside the Templates tab.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { DraftReviewPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** DraftReviewPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <DraftReviewPanel />
  </Page>
);
