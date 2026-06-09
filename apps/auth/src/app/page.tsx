// page.tsx — the auth origin root simply forwards to the identifier-first sign-in screen.
import { redirect } from "next/navigation";

export default function Home(): never {
  redirect("/login");
}
