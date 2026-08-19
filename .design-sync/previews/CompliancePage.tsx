// CompliancePage - the Compliance & data surface (08, 12 §4): the suppression / DNC form and the public DSAR intake, each in its own card, under the "built-in, not bolted on" framing.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { CompliancePage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** CompliancePage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <CompliancePage />
  </Page>
);
