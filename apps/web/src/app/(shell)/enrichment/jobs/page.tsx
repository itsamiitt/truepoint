// (shell)/enrichment/jobs/page.tsx — the thin App Router route for the enrichment job-status surface
// (G-ENR-4). All behavior lives in the feature slice (features/enrichment-jobs); this file only mounts its
// public component inside the (shell) chrome. Not a primary rail tab (the 6-tab nav is fixed) — reached via
// the command palette / deep link, like the import destination.
import { EnrichmentJobsPage } from "@/features/enrichment-jobs";

export default function EnrichmentJobsRoute() {
  return <EnrichmentJobsPage />;
}
