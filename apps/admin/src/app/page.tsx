// page.tsx — the console root. Redirects to the default staff destination (Tenants); the gate runs inside the
// (shell) layout that wraps /tenants, so there is no auth logic here.
import { redirect } from "next/navigation";

export default function Page() {
  redirect("/tenants");
}
