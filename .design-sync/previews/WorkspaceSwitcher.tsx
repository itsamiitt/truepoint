// WorkspaceSwitcher - the pinned-bottom workspace control (11 §3).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { WorkspaceSwitcher } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** WorkspaceSwitcher with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <WorkspaceSwitcher />
  </Page>
);
