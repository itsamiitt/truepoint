// GlobalSuppression — the platform-wide blocklist — domains no workspace may contact, and why each was added.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { GlobalSuppression } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Global suppression with the console's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <GlobalSuppression />
  </Page>
);
