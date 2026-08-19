// (shell)/companies/loading.tsx — table-shaped route skeleton (perf-audit P3.6b): accounts grid
// (select, name, domain, stage, contacts, actions) instead of the group-level centered spinner.
import { Skeleton, TableSkeleton } from "@leadwolf/ui";

export default function CompaniesLoading() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Skeleton width={200} height={20} />
      <TableSkeleton rows={10} columns={[2, 12, 10, 6, 5, 2]} />
    </div>
  );
}
