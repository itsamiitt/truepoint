// ThreadList - the reply threads list with a Mine / Unassigned / By-sequence filter (11 §4.4).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ThreadList } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ThreadList with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <ThreadList />
  </Page>
);
