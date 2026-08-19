// SuppressionForm - add a suppression / DNC entry (08 §3): pick a scope (workspace/tenant) and a match type (email/domain/contact_id), enter the matching value + an optional reason, POST it.
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { SuppressionForm } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** SuppressionForm with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={460}>
    <SuppressionForm />
  </Page>
);
