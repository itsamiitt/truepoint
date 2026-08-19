// OAuthAppsPanel - Developer ▸ OAuth apps: register an OAuth client (name + redirect URIs) and list the registered clients (client id + redirect URIs).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { OAuthAppsPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** OAuthAppsPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <OAuthAppsPanel />
  </Page>
);
