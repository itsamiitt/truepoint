// OrganizationPanel - the Tenant ▸ Organization surface (12 §4): the organization identity form (name / logo / default region), the tenant's workspaces (foundation DataTable, create/archive · M2), and a members-directory summary (StatTiles + a sample list).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { OrganizationPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** OrganizationPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <OrganizationPanel />
  </Page>
);
