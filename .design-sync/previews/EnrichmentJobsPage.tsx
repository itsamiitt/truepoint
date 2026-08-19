// EnrichmentJobsPage - the customer-visible enrichment job-status surface (G-ENR-4; 06 §4.1, 31 §8).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { EnrichmentJobsPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** EnrichmentJobsPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <EnrichmentJobsPage />
  </Page>
);
