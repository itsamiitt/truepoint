// TemplatesPanel - the "Templates" tab: the owner-scoped message-template library (M12 P2) plus a merge-field reference.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { TemplatesPanel } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** TemplatesPanel with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <TemplatesPanel />
  </Page>
);
