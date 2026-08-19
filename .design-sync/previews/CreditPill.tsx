// CreditPill - the top-bar tenant credit balance (11 §1 "Credits is not a tab").
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { CreditPill } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** CreditPill with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <CreditPill />
  </Page>
);
