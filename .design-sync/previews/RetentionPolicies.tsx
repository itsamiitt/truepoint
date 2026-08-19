// RetentionPolicies — per-entity retention windows with the reason each was set — the compliance surface, not the runner.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { RetentionPolicies } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Retention policies with the console's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <RetentionPolicies />
  </Page>
);
