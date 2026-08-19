// ImportWizard - the guided CSV/XLSX import: upload, map columns, preview, commit.
//
// One story. The wizard owns a multi-step machine driven by a real file the user picks, and a card cannot
// supply a File - so what it shows is the first step, which is the step every import starts on.
import { ImportWizard } from "@leadwolf/ui";
import { Page } from "./_webPage";

/** Step one: choose a file. */
export const Start = () => (
  <Page height={820}>
    <ImportWizard onImported={() => {}} onStarted={() => {}} />
  </Page>
);
