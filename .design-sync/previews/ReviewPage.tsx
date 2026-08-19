// ReviewPage — the human-review queue — the captures a parser could not resolve confidently, with reason, priority and assignee.
//
// One story: the page takes no props and fetches through its own hook, so the state a card can show is
// whatever the fixture router answers (see .design-sync/apps/forge/stubs/authClient.ts). The loaded state
// is the one worth designing against — see the note in _appPage.tsx for why per-story states are not
// available here.
import { ReviewPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Review with the pipeline's real data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <ReviewPage />
  </Page>
);
