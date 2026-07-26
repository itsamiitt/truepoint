// BulkRevealDialog — the explicit-id bulk reveal. The ids are pre-filtered to rows that can actually be
// revealed (has an email, not already owned), and the server resolves that selection into an estimate the
// dialog shows BEFORE anything is charged.
//
// The cells vary by selection size, which is what the user actually controls. They deliberately do not vary
// by the `balance` prop: the dialog displays the balance from the server estimate, so a prop-only change
// would render identically and imply a difference that isn't there.
import { BulkRevealDialog } from "@leadwolf/ui";
import { CONTACTS, CREDIT_BALANCE } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

const revealable = CONTACTS.filter((c) => c.hasEmail && !c.isRevealed).map((c) => c.id);

/** A multi-row selection — the common bulk case, with matchable rows resolving free. */
export const Selection = () => (
  <Shell reveal>
    <Stage height={480}>
      <BulkRevealDialog
        contactIds={revealable}
        balance={CREDIT_BALANCE}
        open
        onClose={() => {}}
        onRevealed={() => {}}
      />
    </Stage>
  </Shell>
);

/** One row, reached from a row's overflow menu — singular copy and a one-credit projection. */
export const SingleRow = () => (
  <Shell reveal>
    <Stage height={480}>
      <BulkRevealDialog
        contactIds={[revealable[0]]}
        balance={CREDIT_BALANCE}
        open
        onClose={() => {}}
        onRevealed={() => {}}
      />
    </Stage>
  </Shell>
);
