// SsoConfigPanel - the Tenant ▸ Single sign-on surface (17 §7, ADR-0017/0018): the org's SAML/OIDC identity-provider configuration a security_admin/owner sets — protocol, provider, SAML metadata or OIDC issuer/client, JIT provisioning + default role, and the enable/enforce switches.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SsoConfigPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SsoConfigPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <SsoConfigPanel />
  </Page>
);
