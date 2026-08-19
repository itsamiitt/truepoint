// ImportJobPage - the detail surface for one import: counts, strategy, timestamps and the cancel action.
//
// One story: it takes a jobId and loads the rest itself.
import { ImportJobPage } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** A completed 4,820-row import. */
export const Loaded = () => (
  <Page height={900}>
    <ImportJobPage jobId="00000000-0000-4000-8000-00000000f001" />
  </Page>
);
