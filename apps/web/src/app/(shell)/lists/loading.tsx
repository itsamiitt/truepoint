// (shell)/lists/loading.tsx — table-shaped route skeleton (perf-audit P3.6b): name-heavy lists table
// (name, contact count, updated, actions) instead of the group-level centered spinner.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function ListsLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-4)" }}>
      <Skeleton width={160} height={20} />
      <TableSkeleton rows={8} columns={[12, 4, 6, 2]} />
    </div>
  );
}
