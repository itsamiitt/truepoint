// TenantDetailPage — the customer-360 surface: identity and plan at the top, then the workspaces, members,
// economics, purchases, subscription, ledger, notes and holds panels, each fetching its own slice.
//
// One story, and a demanding one: it exercises nine fixtured routes at once, so it is also the best single
// check that the console's data layer is wired correctly.
//
// The frame is deliberately tall. This surface really is ~2,600px: cutting it short produced a card that
// ended mid-table and read as broken, which is worse than a card you have to scan down.
import { TenantDetailPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Northwind Logistics — an active Team tenant with three workspaces, four members and a real ledger. */
export const Loaded = () => (
  <Page height={2600}>
    <TenantDetailPage tenantId="00000000-0000-4000-8000-000000000101" />
  </Page>
);
