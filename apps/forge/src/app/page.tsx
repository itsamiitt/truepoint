// page.tsx — the console root. Redirects to the default operator destination (Overview); the gate runs inside
// the (shell) layout that wraps /overview, so there is no auth logic here.
import { redirect } from "next/navigation";

export default function Page() {
  redirect("/overview");
}
