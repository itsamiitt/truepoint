// SuppressionList - view + remove existing suppression / DNC entries (08 §3, T-1b27d4ce).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SuppressionList } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SuppressionList with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <SuppressionList />
  </Page>
);
