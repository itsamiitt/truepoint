// InvoicesTab - the billing hub's Invoices tab (Phase 3, M11 / ADR-0041).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { InvoicesTab } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** InvoicesTab with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <InvoicesTab />
  </Page>
);
