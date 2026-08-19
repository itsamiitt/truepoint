// SourceFetchesPage — the live capture pipeline's telemetry: every URL harvested, its outcome, fetch count and whether it resolved a golden record. URLs and outcomes only — the registry holds no PII.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { SourceFetchesPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Source fetches with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <SourceFetchesPage />
  </Page>
);
