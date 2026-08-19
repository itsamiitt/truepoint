// ListsPage - the Lists index surface: every static list in the workspace (workspace-shared), with search + sort, the four async states (loading/empty/error/populated via the State Kit), and create / rename / delete (rename + delete are owner-gated server-side).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { ListsPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** ListsPage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <ListsPage />
  </Page>
);
