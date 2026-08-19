// CrmSyncMonitorPage — connection health across every tenant's HubSpot and Salesforce links, including a revoked-token error and a paused sandbox.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { CrmSyncMonitorPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** CRM sync with the console's data loaded. */
export const Loaded = () => (
  <Page height={880}>
    <CrmSyncMonitorPage />
  </Page>
);
