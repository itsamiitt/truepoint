// data-ops/dedup/page.tsx — thin App Router route for the dedup / ER clerical-review surface
// (database-management-research 07). Behavior lives in features/data-ops; the (shell) chrome + staff adminGate wrap
// it; the server gates GET /admin/data/dedup/links on data:review (it exposes the matched entity name — PII).
import { DedupReviewPage } from "@/features/data-ops";

export default function Page() {
  return <DedupReviewPage />;
}
