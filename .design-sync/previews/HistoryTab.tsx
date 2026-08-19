// HistoryTab - the billing hub's Credit history tab (M11, ADR-0029): the UNIFIED credit statement from the ledger — every movement (top-ups, reveals, adjustments, monthly resets), newest-first, keyset-paginated.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { HistoryTab } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** HistoryTab with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <HistoryTab />
  </Page>
);
