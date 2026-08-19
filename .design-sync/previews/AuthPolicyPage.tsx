// AuthPolicyPage — the platform-default auth policy every org inherits and can only tighten: password floor, MFA, session lifetimes, SSO.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { AuthPolicyPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Auth policy with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <AuthPolicyPage />
  </Page>
);
