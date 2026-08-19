// TenantEconomics — the per-tenant money picture: windowed revenue, credits sold and consumed, provider spend, cost per reveal and margin, plus the lifetime totals. Packs, not subscriptions — there is deliberately no MRR here.
//
// Takes a tenantId and fetches its own slice, so one story: the fixture router answers a single tenant
// (Northwind Logistics). See _appPage.tsx for why per-story states are not available here.
import { TenantEconomics } from "@leadwolf/ui";
import { Page } from "./_appPage";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";

/** Tenant economics for a live tenant. */
export const Loaded = () => (
  <Page height={620}>
    <TenantEconomics tenantId={TENANT_ID} />
  </Page>
);
