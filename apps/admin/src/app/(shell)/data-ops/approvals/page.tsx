// data-ops/approvals/page.tsx — thin App Router route for the maker-checker review queue
// (database-management-research 09). Behavior lives in features/data-ops; the (shell) chrome + staff adminGate
// wrap it; the server gates GET /admin/data/approvals + the decide endpoints on data:review (and enforces
// requester != approver). The MAKER path (filing a request, data:manage) is wired by each high-risk op.
import { ApprovalsPage } from "@/features/data-ops";

export default function Page() {
  return <ApprovalsPage />;
}
