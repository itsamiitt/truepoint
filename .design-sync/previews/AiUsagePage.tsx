// AiUsagePage — per-tenant AI request volume, guard/model failures, repairs, latency and token spend over the trailing window.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { AiUsagePage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** AI usage with the console's data loaded. */
export const Loaded = () => (
  <Page height={820}>
    <AiUsagePage />
  </Page>
);
