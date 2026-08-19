// PlansPage — the plan-template catalogue: seat and workspace limits, monthly credit grants, and the feature matrix each plan unlocks.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { PlansPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Plans with the console's data loaded. */
export const Loaded = () => (
  <Page height={880}>
    <PlansPage />
  </Page>
);
