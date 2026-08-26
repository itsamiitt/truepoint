// (shell)/lists/[id]/loading.tsx — table-shaped route skeleton (perf-audit P3.6b): the list detail is a
// members grid, so it gets the contacts-grid default weights; the extra header line stands in for the
// back-link + title block.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function ListDetailLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--tp-space-4)" }}>
      <Skeleton width={90} height={12} />
      <Skeleton width={240} height={20} />
      <TableSkeleton rows={10} />
    </div>
  );
}
