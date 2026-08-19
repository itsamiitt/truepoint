// EnrollmentPanel - the enrollment surface for one sequence: who is enrolled, where they are, and the
// per-row send.
import { EnrollmentPanel } from "@leadwolf/ui";
import * as D from "./_webData";
import { Stage } from "./_webPage";

const SEQ = D.W.SEQUENCES.sequences;

/** An active sequence with 812 enrolled. */
export const Active = () => (
  <Stage height={700}>
    <EnrollmentPanel sequence={SEQ[0]} onClose={() => {}} onChanged={() => {}} />
  </Stage>
);

/** A draft sequence - nothing enrolled yet. */
export const Draft = () => (
  <Stage height={520}>
    <EnrollmentPanel sequence={SEQ[3]} onClose={() => {}} onChanged={() => {}} />
  </Stage>
);
