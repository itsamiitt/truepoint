// page.tsx — the app root. The work surface is the (shell) route group; "/" just redirects to the default
// destination (Prospect, 04 §3). Auth/session resolution lives in the AppShell (which wraps every (shell)
// route), not here. This is a Server Component: the redirect is issued server-side (no client bundle, no
// useEffect hop, no flash of root content) so a direct visit to "/" never ships an intermediate page.
import { redirect } from "next/navigation";

export default function Home() {
  redirect("/prospect");
}
