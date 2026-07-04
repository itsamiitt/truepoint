// page.tsx — retired route (import-redesign 11 §1.1): the import surface moved inside the (shell) group at
// /imports/new (S-U1 route scaffolding). This redirect is kept for one release so bookmarks, notification
// deep links, and stale entry points land on the new home; then the file is deleted.
import { redirect } from "next/navigation";

export default function Page(): never {
  redirect("/imports/new");
}
