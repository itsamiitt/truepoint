// (shell)/layout.tsx — the route-group layout that wraps every staff destination in the AdminShell chrome
// (rail + top bar + the two-stage auth/staff gate). Routes under (shell) inherit the shell without affecting
// the URL (the group name is not a path segment). Mirrors apps/web's (shell) layout.
import { AdminShell } from "@/components/shell/AdminShell";
import type { ReactNode } from "react";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
