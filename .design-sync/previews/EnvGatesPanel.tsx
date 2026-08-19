// EnvGatesPanel — the deploy-time master switches. A per-tenant flag can never turn one of these on — that is the point of the dual gate.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { EnvGatesPanel } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Env gates with the console's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <EnvGatesPanel />
  </Page>
);
