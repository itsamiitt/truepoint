// VerificationRunsPage — per-tenant reverification sweeps: scanned, reverified and errored counts per run.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { VerificationRunsPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Verification runs with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <VerificationRunsPage />
  </Page>
);
