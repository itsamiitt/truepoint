// data-ops/validation/page.tsx — thin App Router route for the data-quality rule builder
// (database-management-research 06). Behavior lives in features/data-ops; the (shell) chrome + staff adminGate
// wrap it; the server gates the list on data:read and create/update/toggle/delete on data:manage (audited).
import { ValidationRulesPage } from "@/features/data-ops";

export default function Page() {
  return <ValidationRulesPage />;
}
