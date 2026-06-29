// data-ops/imports/[jobId]/page.tsx — thin App Router route for one bulk-import job's drill-down
// (database-management-research Phase 1D). In Next.js 15 `params` is a Promise (awaited here); the slice component
// (features/data-ops) does the data fetch + render. The (shell) chrome + staff adminGate wrap it; the server
// additionally gates GET /admin/data/imports/:jobId on the data:read capability.
import { DataImportDetailPage } from "@/features/data-ops";

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <DataImportDetailPage jobId={jobId} />;
}
