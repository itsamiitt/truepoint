// (shell)/imports/[jobId]/page.tsx — the thin App Router route for ONE bulk import's live status (backlog #2).
// All behavior lives in the feature slice (features/import → BulkImportProgress); this file only resolves the
// route param and mounts the slice component inside the (shell) chrome. Reached by deep link only (the wizard's
// client-side bulk hand-off died with the "Large file" toggle — import-redesign 11 §1.4, S-U1); the durable job
// page (11 §4, S-U3) generalizes this surface to every import later.
// In Next.js 15 `params` is a Promise (awaited here); the slice component does the polling + render.
import { BulkImportProgress } from "@/features/import";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <BulkImportProgress jobId={jobId} />;
}
