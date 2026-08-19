// ProviderPriorityPanel - the Workspace ▸ Enrichment providers settings form (waterfall v2 / 0111; 06 §4 "the ordering is configurable, not hardcoded — per-field provider preferences are data") [S-04] [S-08].
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ProviderPriorityPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ProviderPriorityPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <ProviderPriorityPanel />
  </Page>
);
