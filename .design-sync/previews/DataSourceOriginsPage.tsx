// DataSourceOriginsPage — the provider origin registry: base URLs, key hints, priority order, pause state and consecutive-failure counts.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { DataSourceOriginsPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Data sources with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <DataSourceOriginsPage />
  </Page>
);
