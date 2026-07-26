// AddToListDialog — add the selected contacts to a static list, or create one inline. Takes explicit ids
// only: the lists endpoint has no select-all-across-search escalation, by design.
import { AddToListDialog } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

const twelve = CONTACTS.slice(0, 12).map((c) => c.id);

/** Twelve selected rows, with the workspace's lists loaded and their member counts. */
export const Picking = () => (
  <Shell>
    <Stage height={520}>
      <AddToListDialog open contactIds={twelve} onClose={() => {}} onAdded={() => {}} />
    </Stage>
  </Shell>
);

/** A single row — the same dialog reached from a row's overflow menu rather than the bulk bar. */
export const SingleRow = () => (
  <Shell>
    <Stage height={520}>
      <AddToListDialog open contactIds={[CONTACTS[0].id]} onClose={() => {}} onAdded={() => {}} />
    </Stage>
  </Shell>
);
