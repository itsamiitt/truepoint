// AutoEnrichPanel - the Workspace ▸ Auto-enrich settings form (G-ENR-1; 29 §3).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { AutoEnrichPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** AutoEnrichPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <AutoEnrichPanel />
  </Page>
);
