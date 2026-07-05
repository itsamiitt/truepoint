// (shell)/imports/[jobId]/page.tsx — the durable, full-page status view for ONE import (import-redesign 11 §4,
// S-U3). The sync wizard navigates here on submit, and the URL is the handle: refresh/return resumes and the
// poll never gives up. All behavior lives in the feature slice (features/import → ImportJobPage), which reads
// GET /imports/:jobId (the additive v2 detail when the gate is on, the legacy poll shape otherwise).
// NOTE: this route previously mounted the dark bulk-progress surface (BulkImportProgress, deep-link only). Bulk
// is gate-off with no live producer, so it is repointed here; the bulk surface re-wires at Phase 2 (16 drift).
// In Next.js 15 `params` is a Promise (awaited here); the slice component does the polling + render.
import { ImportJobPage } from "@/features/import";

export const dynamic = "force-dynamic";

export default async function Page({ params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  return <ImportJobPage jobId={jobId} />;
}
