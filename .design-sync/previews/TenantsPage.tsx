// TenantsPage — the tenant directory with plan, status, seat limits and credit balance, including dunning and staff suspensions.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { TenantsPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Tenants with the console's data loaded. */
export const Loaded = () => (
  <Page height={880}>
    <TenantsPage />
  </Page>
);
