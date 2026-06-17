// TeamActivitySection.tsx — the Team activity dashboard: a sortable DataTable of each member's contribution
// (contacts owned/revealed, credits spent, engaged) derived from the masked owner ids on contacts + usage.
// Member identity is PII-free (a short label from the id) until a workspace-members endpoint lands. StateSwitch
// handles loading/empty/error. Presentation only over the team rollup.
"use client";

import { type Column, DataTable, EmptyState, Icon, StatTile, StateSwitch } from "@leadwolf/ui";
import { Users } from "lucide-react";
import styles from "../reports.module.css";
import type { TeamMemberRow, TeamRollup } from "../types";

const COLUMNS: Column<TeamMemberRow>[] = [
  {
    key: "label",
    header: "Member",
    cell: (r) => r.label,
    sortValue: (r) => r.label,
  },
  {
    key: "revealed",
    header: "Revealed",
    align: "right",
    cell: (r) => r.revealed.toLocaleString(),
    sortValue: (r) => r.revealed,
  },
  {
    key: "engaged",
    header: "Engaged",
    align: "right",
    cell: (r) => r.engaged.toLocaleString(),
    sortValue: (r) => r.engaged,
  },
  {
    key: "credits",
    header: "Credits",
    align: "right",
    cell: (r) => r.credits.toLocaleString(),
    sortValue: (r) => r.credits,
  },
];

export function TeamActivitySection({
  rollup,
  loading,
  error,
  onRetry,
}: {
  rollup: TeamRollup | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <StateSwitch
      loading={loading}
      error={error}
      onRetry={onRetry}
      empty={!loading && !error && (rollup?.members ?? 0) === 0}
      emptyState={
        <EmptyState
          icon={<Icon icon={Users} size={28} />}
          title="No member activity yet"
          description="Once teammates reveal contacts, per-member reveals, engagement, and spend show up here."
        />
      }
    >
      {rollup ? (
        <>
          <div className={styles.tiles}>
            <StatTile
              label="Active members"
              value={rollup.members.toLocaleString()}
              sublabel="With at least one revealed contact"
            />
            <StatTile
              label="Contacts revealed"
              value={rollup.totalRevealed.toLocaleString()}
              sublabel="Across the team in this range"
            />
          </div>

          <h3 className={styles.subheading}>By member</h3>
          <DataTable columns={COLUMNS} rows={rollup.rows} rowKey={(r) => r.userId} />
          <p className={styles.footnote}>
            Members are shown by a privacy-safe id until the workspace-members directory ships
            (post-MVP).
          </p>
        </>
      ) : null}
    </StateSwitch>
  );
}
