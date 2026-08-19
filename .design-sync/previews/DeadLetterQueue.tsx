// DeadLetterQueue — sync jobs that exhausted their retries, with the error class and detail an operator needs to decide replay or drop.
//
// One story: the surface takes no props and fetches through its own hook, so what a card can show is
// whatever the fixture router answers (.design-sync/apps/admin/stubs/authClient.ts). See _appPage.tsx for
// why per-story states are not available to a fetch-driven page.
import { DeadLetterQueue } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** CRM dead letters with the console's data loaded. */
export const Loaded = () => (
  <Page height={760}>
    <DeadLetterQueue />
  </Page>
);
