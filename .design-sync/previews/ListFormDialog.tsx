// ListFormDialog - create or rename a list. `list: null` is create mode; a list is edit mode.
import { ListFormDialog } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

/** Create: an empty form. */
export const Create = () => (
  <Stage height={440}>
    <ListFormDialog open list={null} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);

/** Edit an existing list, pre-filled. */
export const Rename = () => (
  <Stage height={440}>
    <ListFormDialog open list={D.LIST} onClose={() => {}} onSaved={() => {}} />
  </Stage>
);
