// compliance/page.tsx — the thin App Router route for the compliance / DSAR oversight surface. Behavior lives
// in the feature slice (features/compliance); this file only mounts its public component inside the (shell).
import { CompliancePage } from "@/features/compliance";

export default function Page() {
  return <CompliancePage />;
}
