// staff/page.tsx — the thin App Router route for Staff RBAC management. Behavior lives in the feature slice
// (features/staff); this file only mounts its public component inside the (shell) chrome.
import { StaffPage } from "@/features/staff";

export default function Page() {
  return <StaffPage />;
}
