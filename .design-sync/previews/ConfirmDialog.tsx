// ConfirmDialog - the shared confirm for anything irreversible. The destructive variant is a distinct
// visual state, not just different copy, because the two are read at a glance.
import { ConfirmDialog } from "@leadwolf/ui";
import { Stage } from "./_webPage";

/** The destructive form: the action is irreversible and the confirm carries the danger tone. */
export const Destructive = () => (
  <Stage height={420}>
    <ConfirmDialog
      open
      destructive
      title="Delete this list?"
      body="The list and its 1,284 members are removed. The contacts themselves are not deleted."
      confirmLabel="Delete list"
      onClose={() => {}}
      onConfirm={() => {}}
    />
  </Stage>
);

/** A non-destructive confirm, for something merely worth pausing over. */
export const Neutral = () => (
  <Stage height={420}>
    <ConfirmDialog
      open
      title="Cancel this import?"
      body="Rows already imported stay in the workspace. The remaining rows are not processed."
      confirmLabel="Cancel import"
      onClose={() => {}}
      onConfirm={() => {}}
    />
  </Stage>
);

/** Mid-confirm: the action is in flight and cannot be double-fired. */
export const Busy = () => (
  <Stage height={420}>
    <ConfirmDialog
      open
      destructive
      busy
      title="Delete this list?"
      body="The list and its 1,284 members are removed."
      confirmLabel="Delete list"
      onClose={() => {}}
      onConfirm={() => {}}
    />
  </Stage>
);
