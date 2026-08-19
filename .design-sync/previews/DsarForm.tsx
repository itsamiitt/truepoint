// DsarForm - Data Subject Access Request intake (08 §4): pick a request type (access/delete/rectify), enter the subject's email, and POST to the PUBLIC, session-less endpoint.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { DsarForm } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** DsarForm with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <DsarForm />
  </Page>
);
