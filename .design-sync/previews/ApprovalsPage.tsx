// ApprovalsPage — the two-person-rule queue: cross-tenant bulk exports and retention enforcement flips waiting on a second staff decision.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { ApprovalsPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Approvals with the console's data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <ApprovalsPage />
  </Page>
);
