// SubscriptionTab - the billing hub's Subscription tab (M11 subs, ADR-0041): the tenant's current subscription (plan, status, renew/end date), or the month-to-month default when there's none.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SubscriptionTab } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SubscriptionTab with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <SubscriptionTab />
  </Page>
);
