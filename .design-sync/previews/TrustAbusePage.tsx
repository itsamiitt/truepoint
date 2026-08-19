// TrustAbusePage — signup velocity, free-email signups, and the current hold and tenant-status distribution.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { TrustAbusePage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Trust and abuse with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <TrustAbusePage />
  </Page>
);
