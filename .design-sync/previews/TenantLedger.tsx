// TenantLedger — the signed credit movements with the running balance after each: grants, spends, a non-match credit-back and a goodwill adjustment.
//
// Takes a tenantId and fetches its own slice, so one story: the fixture router answers a single tenant
// (Northwind Logistics). See _appPage.tsx for why per-story states are not available here.
import { TenantLedger } from "@leadwolf/ui";
import { Page } from "./_appPage";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";

/** Credit ledger for a live tenant. */
export const Loaded = () => (
  <Page height={620}>
    <TenantLedger tenantId={TENANT_ID} />
  </Page>
);
