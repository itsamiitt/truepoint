// BillingPage - the customer Billing & Credits HUB (OD-3): a tabbed surface over the tenant's plan, credits, usage history, invoices and subscription.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { BillingPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** BillingPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <BillingPage />
  </Page>
);
