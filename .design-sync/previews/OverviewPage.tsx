// OverviewPage — the operator dashboard: four KPI tiles over the recent-captures table, every async state routed through the shared State Kit.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { OverviewPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Overview with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={900}>
    <OverviewPage />
  </Page>
);
