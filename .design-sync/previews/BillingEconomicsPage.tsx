// BillingEconomicsPage — the credit-economics rollup — credits sold, revenue, provider spend, cost per reveal and margin — with the daily trend and a per-tenant breakdown.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { BillingEconomicsPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Billing economics with the console's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <BillingEconomicsPage />
  </Page>
);
