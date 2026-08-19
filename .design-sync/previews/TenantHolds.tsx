// TenantHolds — abuse and fraud holds on the tenant, active first — here a payment review that was placed and later lifted.
//
// Takes a tenantId and fetches its own slice, so one story: the fixture router answers a single tenant
// (Northwind Logistics). See _appPage.tsx for why per-story states are not available here.
import { TenantHolds } from "@leadwolf/ui";
import { Page } from "./_appPage";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";

/** Holds for a live tenant. */
export const Loaded = () => (
  <Page height={460}>
    <TenantHolds tenantId={TENANT_ID} />
  </Page>
);
