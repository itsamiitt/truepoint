// HomePage - the Home cockpit: a row of KPI StatTiles (tenant credit pool · recent reveals · verified- data billing) over a responsive widget grid (tasks, replies, reveals, hot leads, this-workspace burn, sequences, imports, enrichment, activity feed).
//
// One story: the surface takes no props and loads its own data, so what a card can show is whatever the
// fixture router answers (.design-sync/prospect/stubs/authClient.ts). See _webPage.tsx for why per-story
// states are not available to a fetch-driven surface.
import { HomePage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** HomePage with the workspace's data loaded. */
export const Loaded = () => (
  <Page height={1000}>
    <HomePage />
  </Page>
);
