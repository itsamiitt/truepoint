// AccountDetailDrawer — the read-only company panel behind a row in the Accounts scope. Firmographics and
// the workspace's contact rollup only; accounts hold no PII, so there is no reveal seam here.
import { AccountDetailDrawer } from "@leadwolf/ui";
import { ACCOUNTS } from "../prospect/fixtures";
import { Shell, Stage } from "./_prospectShell";

/** A well-populated account, with the hand-off that switches the page to its contacts. */
export const Populated = () => (
  <Shell>
    <Stage height={600}>
      <AccountDetailDrawer account={ACCOUNTS[0]} onClose={() => {}} onViewContacts={() => {}} />
    </Stage>
  </Shell>
);

/** Without the contacts hand-off — the button is hidden when the prop is omitted. */
export const NoHandoff = () => (
  <Shell>
    <Stage height={600}>
      <AccountDetailDrawer account={ACCOUNTS[4]} onClose={() => {}} />
    </Stage>
  </Shell>
);
