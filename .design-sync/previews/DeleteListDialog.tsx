// DeleteListDialog - confirm deleting a list. `list: null` keeps it inert, which is how the parent closes
// it without unmounting.
//
// Deleting a list removes the list, never the contacts in it - the copy has to be unambiguous about that.
import { DeleteListDialog } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

/** Confirming deletion of a 1,284-member list. */
export const Confirming = () => (
  <Stage height={420}>
    <DeleteListDialog open list={D.LIST} onClose={() => {}} onDeleted={() => {}} />
  </Stage>
);

/** Inert - `list: null` renders nothing. */
export const Inert = () => (
  <Stage height={180}>
    <DeleteListDialog open list={null} onClose={() => {}} onDeleted={() => {}} />
  </Stage>
);
