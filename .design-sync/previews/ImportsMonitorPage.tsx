// ImportsMonitorPage — every tenant's import jobs with antivirus status, row outcomes and failure reasons, including a quarantined upload.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { ImportsMonitorPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Imports with the console's data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <ImportsMonitorPage />
  </Page>
);
