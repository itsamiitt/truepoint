// ParsersPage — the parser registry: name, kind, status, recent success rate and last run, including a degraded parser and a retired one.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { ParsersPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Parsers with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <ParsersPage />
  </Page>
);
