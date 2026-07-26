// BulkRevealJobDialog — the "select all N matching" reveal. Unlike the explicit-id path, the selection is
// a QUERY: the server resolves and caps it, returns an estimate, and waits for confirmation before it
// spends. The job then reports requested / billable / revealed / failed as it runs.
//
// The two cells differ by reveal type, which is what drives the price — and at the default full-profile
// rate this selection exceeds the balance, so the card also shows the insufficient-credits gate.
import { BulkRevealJobDialog } from "@leadwolf/ui";
import { CONTACT_QUERY } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

/** Full-profile over the whole result set — projected spend exceeds the balance, so the dialog surfaces
 *  the shortfall and a top-up route instead of letting the run start. */
export const InsufficientCredits = () => (
  <Shell reveal>
    <Stage height={520}>
      <BulkRevealJobDialog open onClose={() => {}} criteria={CONTACT_QUERY} onDone={() => {}} />
    </Stage>
  </Shell>
);

/** The same selection scoped to phone reveals — cheaper per record, so it fits the balance and confirms
 *  cleanly. Same dialog, no warning block. */
export const PhoneJob = () => (
  <Shell reveal>
    <Stage height={520}>
      <BulkRevealJobDialog
        open
        onClose={() => {}}
        criteria={CONTACT_QUERY}
        revealType={"phone" as never}
        onDone={() => {}}
      />
    </Stage>
  </Shell>
);
