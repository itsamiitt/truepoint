// users/page.tsx — the thin App Router route for the global Users directory. Behavior lives in the feature
// slice (features/users); this file only mounts its public component inside the (shell) chrome.
import { UsersPage } from "@/features/users";

export default function Page() {
  return <UsersPage />;
}
