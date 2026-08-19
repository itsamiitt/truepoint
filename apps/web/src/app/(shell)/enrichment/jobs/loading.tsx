// (shell)/enrichment/jobs/loading.tsx — table-shaped route skeleton (perf-audit P3.6b): jobs history
// table (file, status, progress, counts, when) instead of the group-level centered spinner.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function EnrichmentJobsLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Skeleton width={200} height={20} />
      <TableSkeleton rows={8} columns={[10, 5, 6, 5, 4]} />
    </div>
  );
}
