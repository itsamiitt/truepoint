// ImportDraftsBanner - the "unfinished drafts" resume entry above the import history table (S-U7; 11 §2.1's slim Resume-draft alert over the 08 §7 `?state=draft` opt-in read).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ImportDraftsBanner } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ImportDraftsBanner with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <ImportDraftsBanner />
  </Page>
);
