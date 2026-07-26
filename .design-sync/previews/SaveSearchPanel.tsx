// SaveSearchPanel — "Save search" plus the workspace's saved segments (M8, 24 §8). Owned rows get
// rename/delete; shared rows created by a teammate are apply-only. The list comes from /saved-searches
// through the fixture router, so the card shows the real loaded state rather than a hard-coded list.
import { SaveSearchPanel } from "@leadwolf/ui";
import { CONTACT_QUERY } from "../prospect/fixtures";
import { Shell } from "./_prospectShell";

const rail: React.CSSProperties = { width: 264, background: "var(--tp-surface)", padding: 12 };

/** Four saved searches — two private to the user, two shared with the workspace. */
export const Saved = () => (
  <Shell>
    <div style={rail}>
      <SaveSearchPanel currentQuery={CONTACT_QUERY} onApply={() => {}} />
    </div>
  </Shell>
);
