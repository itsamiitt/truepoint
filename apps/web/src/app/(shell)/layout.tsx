import { AppShell } from "@/components/shell/AppShell";
import { RealtimeBridge } from "@/components/shell/RealtimeBridge";
// (shell)/layout.tsx — the route-group layout that wraps every signed-in destination in the AppShell chrome
// (rail + top bar + auth gate). Routes under (shell) inherit the shell without affecting the URL (the group
// name is not a path segment). Auth, session, and the credit pill all live in the shell, not here.
import type { ReactNode } from "react";

export default function ShellLayout({ children }: { children: ReactNode }) {
  return (
    <AppShell>
      {/* App-wide realtime → window-event bus (credits:changed / reveal:changed). Inert while dark. */}
      <RealtimeBridge />
      {children}
    </AppShell>
  );
}
