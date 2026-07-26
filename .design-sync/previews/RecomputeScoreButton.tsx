// RecomputeScoreButton — re-runs scoring for one contact (ADR-0008) and hands the refreshed history back
// to the detail panel's score block. Server-computed; the button never derives a score client-side.
import { RecomputeScoreButton } from "@leadwolf/ui";
import { CONTACTS } from "../prospect/fixtures";
import { Shell, pad } from "./_prospectShell";

/** Idle, as it sits in the record detail's score header. */
export const Idle = () => (
  <Shell>
    <div style={{ ...pad, display: "flex", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--tp-ink-2)" }}>SCORE</span>
      <RecomputeScoreButton contactId={CONTACTS[0].id} onScored={() => {}} />
    </div>
  </Shell>
);
