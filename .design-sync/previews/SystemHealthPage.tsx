// SystemHealthPage — service status, live queue depths and job counts. An unreachable queue reports null rather than a fabricated zero.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { SystemHealthPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** System health with the console's data loaded. */
export const Loaded = () => (
  <Page height={880}>
    <SystemHealthPage />
  </Page>
);
