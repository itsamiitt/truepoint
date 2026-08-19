// (shell)/prospect/loading.tsx — table-shaped route skeleton (perf-audit P3.6b). The destination is the
// contacts grid, so the pending state matches that shape instead of the group-level centered spinner —
// nearest loading.tsx wins. Default TableSkeleton weights approximate the grid: select, name, company, data ×2, actions.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function ProspectLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Skeleton width={200} height={20} />
      <TableSkeleton rows={10} />
    </div>
  );
}
