// SecurityAccessPanel - the Tenant ▸ Security & access surface (ADR-0018, 17 §10): the org-wide auth policy a security_admin/owner sets — MFA enforcement, allowed login methods, enforce-SSO, disable-social, session timeout, and an IP allowlist (CIDR per line).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SecurityAccessPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SecurityAccessPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <SecurityAccessPanel />
  </Page>
);
