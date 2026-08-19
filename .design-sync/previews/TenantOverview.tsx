// TenantOverview — reveal volume over the window and lifetime, last reveal, and any active holds.
//
// Takes a tenantId and fetches its own slice, so one story: the fixture router answers a single tenant
// (Northwind Logistics). See _appPage.tsx for why per-story states are not available here.
import { TenantOverview } from "@leadwolf/ui";
import { Page } from "./_appPage";

const TENANT_ID = "00000000-0000-4000-8000-000000000101";

/** Customer 360 for a live tenant. */
export const Loaded = () => (
  <Page height={380}>
    <TenantOverview tenantId={TENANT_ID} />
  </Page>
);
