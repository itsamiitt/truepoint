// BulkImportProgress - the live progress panel for one bulk import, polled while the job runs.
//
// One story: it takes only a jobId and polls its own status, so what a card can show is whatever the
// fixture router answers.
import { BulkImportProgress } from "@leadwolf/ui";
import { Frame } from "./_webPage";

/** A job in progress. */
export const Running = () => (
  <Frame>
    <BulkImportProgress jobId="00000000-0000-4000-8000-00000000f002" />
  </Frame>
);
