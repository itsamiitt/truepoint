// PublicPricingPage - the PUBLIC, unauthenticated transparent pricing surface (ADR-0012).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { PublicPricingPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** PublicPricingPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <PublicPricingPage />
  </Page>
);
