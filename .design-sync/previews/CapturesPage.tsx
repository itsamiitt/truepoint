// CapturesPage — the captured-items feed — source, parser, status and capture time for everything the pipeline has taken in.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { CapturesPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Captures with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <CapturesPage />
  </Page>
);
