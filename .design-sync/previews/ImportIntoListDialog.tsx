// ImportIntoListDialog - run an import whose rows land directly in one list.
import { ImportIntoListDialog } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

/** Importing into an existing list. */
export const Open = () => (
  <Stage height={640}>
    <ImportIntoListDialog open list={D.LIST} onClose={() => {}} onImported={() => {}} />
  </Stage>
);
