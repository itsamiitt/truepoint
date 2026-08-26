// (shell)/sequences/loading.tsx — table-shaped route skeleton (perf-audit P3.6b): sequences table
// (name, status, steps, enrolled, actions) instead of the group-level centered spinner.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function SequencesLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-4)" }}>
      <Skeleton width={180} height={20} />
      <TableSkeleton rows={8} columns={[12, 5, 4, 4, 3]} />
    </div>
  );
}
