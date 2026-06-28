// (shell)/imports/[jobId]/page.tsx — the thin App Router route for ONE bulk import's live status (backlog #2).
// All behavior lives in the feature slice (features/import → BulkImportProgress); this file only resolves the
// route param and mounts the slice component inside the (shell) chrome. Not a primary rail tab (the 7-tab nav is
// fixed) — reached from the import wizard's large-file hand-off / a deep link, like the enrichment-jobs route.
// In Next.js 15 `params` is a Promise (awaited here); the slice component does the polling + render.
import { BulkImportProgress } from "@/features/import";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <BulkImportProgress jobId={jobId} />;
}
