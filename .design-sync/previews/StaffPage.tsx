// StaffPage — the staff directory: who holds which platform role, when it was granted, and which grants are revoked.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { StaffPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Staff with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <StaffPage />
  </Page>
);
