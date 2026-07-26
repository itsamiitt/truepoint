// RecentSearches — the per-browser recent-search row above the rail's facet groups (24). Stored locally,
// never server-side; an empty list renders nothing at all, which is why there is no "empty" cell here.
import { RecentSearches } from "@leadwolf/ui";
import { RECENTS } from "../prospect/fixtures";
import { Shell } from "./_prospectShell";

const rail: React.CSSProperties = { width: 264, background: "var(--tp-surface)", padding: 12 };

/** Three recents, newest first — a facet search, a free-text search, and an industry cut. */
export const Recents = () => (
  <Shell>
    <div style={rail}>
      <RecentSearches recents={RECENTS} onApply={() => {}} onClear={() => {}} />
    </div>
  </Shell>
);
