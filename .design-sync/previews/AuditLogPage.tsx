// AuditLogPage — the platform audit trail — every staff action with actor, target, tenant and source IP, keyset-paged and AND-filterable.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { AuditLogPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Audit log with the console's data loaded. */
export const Loaded = () => (
  <Page height={880}>
    <AuditLogPage />
  </Page>
);
