// (shell)/layout.tsx — the route-group layout that wraps every operator destination in the ForgeShell chrome
// (rail + top bar + the two-stage auth/staff gate). Routes under (shell) inherit the shell without affecting the
// URL (the group name is not a path segment). Mirrors apps/admin's (shell) layout.
import { ForgeShell } from "@/components/shell/ForgeShell";
import type { ReactNode } from "react";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return <ForgeShell>{children}</ForgeShell>;
}
