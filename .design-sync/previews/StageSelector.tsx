// StageSelector — assigns a pipeline stage to one contact (G-REV-7, ADR-0028). Assigning rolls the
// contact's canonical outreach_status up SERVER-side; the control never computes the rollup itself.
import { StageSelector } from "@leadwolf/ui";
import { CONTACTS, STAGES } from "../prospect/fixtures";
import { Shell, pad } from "./_prospectShell";

/** A contact sitting in "Engaged" — the stage list loads from /pipeline-stages. */
export const Assigned = () => (
  <Shell>
    <div style={pad}>
      <StageSelector contactId={CONTACTS[0].id} stageId={STAGES[2].id} onAssigned={() => {}} />
    </div>
  </Shell>
);

/** No stage yet — the unset state a freshly imported record opens in. */
export const Unset = () => (
  <Shell>
    <div style={pad}>
      <StageSelector contactId={CONTACTS[3].id} stageId={null} onAssigned={() => {}} />
    </div>
  </Shell>
);
