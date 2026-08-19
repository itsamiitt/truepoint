// DataImportDetailPage — one import job in full: antivirus status, conflict policy, chunk progress, the row
// outcome breakdown, and the reject histogram that tells an operator WHY rows were dropped.
import { DataImportDetailPage } from "@leadwolf/ui";
import { Page } from "./_appPage";

/** A completed 4,820-row import: 3,991 created, 742 matched, 87 rejected across four reject reasons. */
export const Completed = () => (
  <Page height={1000}>
    <DataImportDetailPage jobId="imp_01hq8z1" />
  </Page>
);
