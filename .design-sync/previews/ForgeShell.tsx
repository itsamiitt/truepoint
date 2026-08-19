// ForgeShell — the operator console's chrome: the two-stage authn/authz gate (ADR-0011 / ADR-0034) wrapped
// around the shared AppShellFrame (sidebar, top bar, command palette, shortcuts dialog).
//
// The gate is NOT stubbed. `verifyForgeStaff` really runs and really probes `/bff/me`; the fixture router
// answers with a data_ops staff payload, so what the card shows is the authorized branch the real gate
// resolved to — not a bypass. Point the fixture at a 403 and this same component would render its
// forbidden state.
//
// One story: the shell frames a page, and the framed page is the render worth seeing. Its gate states are
// mutually exclusive whole-screen branches driven by the same module-level fixture router, so they cannot
// vary per cell (see _appPage.tsx).
import { ForgeShell, OverviewPage } from "@leadwolf/ui";

/** The console as an operator sees it: staff gate passed, sidebar and top bar mounted, Overview loaded. */
export const Console = () => (
  <div style={{ height: 900, overflow: "hidden", borderRadius: 8 }}>
    <ForgeShell>
      <OverviewPage />
    </ForgeShell>
  </div>
);
