// TenantPurchases — the tenant's credit-pack purchases including a refunded one, with the refund action staff use.
//
// Takes a tenantId and fetches its own slice, so one story: the fixture router answers a single tenant
// (Northwind Logistics). See _appPage.tsx for why per-story states are not available here.
import { TenantPurchases } from "@leadwolf/ui";
import { Page } from "./_appPage";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";

/** Purchases for a live tenant. */
export const Loaded = () => (
  <Page height={520}>
    <TenantPurchases tenantId={TENANT_ID} onRefunded={() => {}} />
  </Page>
);
