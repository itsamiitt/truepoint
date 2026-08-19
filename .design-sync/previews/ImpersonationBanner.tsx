// ImpersonationBanner — the standing warning shown while a staff member is acting as a customer. It renders nothing when no impersonation is active — which is the state a preview has.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { ImpersonationBanner } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Impersonation banner with the console's data loaded. */
export const Loaded = () => (
  <Page height={320}>
    <ImpersonationBanner />
  </Page>
);
