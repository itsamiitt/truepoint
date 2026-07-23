// page.tsx — /auth-policy route shell (RSC). Mounts the client feature component; all GET/PUT happens in the
// "use client" feature via fetchWithAuth (the Bearer token is in-memory browser state, never available in RSC).
import { AuthPolicyPage } from "../../../features/auth-policy";

export default function Page(): React.JSX.Element {
  return <AuthPolicyPage />;
}
