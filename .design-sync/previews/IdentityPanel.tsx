// IdentityPanel - the Tenant ▸ Security ▸ Domains & SCIM surface (enterprise IAM, 17 / ADR-0017/0018): the org claims + verifies DNS domains (which drive SSO routing / auto-join) and mints/revokes the SCIM bearer tokens its identity provider uses to provision users.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { IdentityPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** IdentityPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <IdentityPanel />
  </Page>
);
