// DataOpsOverviewPage — the pipeline control room: job counts by status, queue depth, dead letters, and recent import throughput.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { DataOpsOverviewPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Data ops with the console's data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <DataOpsOverviewPage />
  </Page>
);
