// SyncStatusPage — the downstream-sync health board — each destination with its health, pending backlog and last successful sync, including a degraded queue and a paused one.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { SyncStatusPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Sync status with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <SyncStatusPage />
  </Page>
);
