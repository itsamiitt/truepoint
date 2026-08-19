// SessionsPanel - Workspace ▸ Security ▸ Sessions (G-AUTH-2): a DataTable of the active sessions of this workspace's members, with a confirmed "Revoke" per session and a "Sign out everywhere" (force re-auth) per member.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SessionsPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SessionsPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <SessionsPanel />
  </Page>
);
