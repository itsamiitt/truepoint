// RetentionRunsPanel — what each enforcement pass actually deleted, including an observe-mode run that deleted nothing by design.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { RetentionRunsPanel } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** Retention runs with the console's data loaded. */
export const Loaded = () => (
  <Page height={700}>
    <RetentionRunsPanel />
  </Page>
);
