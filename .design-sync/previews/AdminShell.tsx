// AdminShell — the staff console's chrome: the platform-admin gate wrapped around the shared AppShellFrame
// (rail, top bar, command palette, shortcuts dialog).
//
// The gate is NOT stubbed. adminGate.verifyPlatformAdmin really runs and classifies the caller on the STATUS
// of a probe to /admin/system-health (200 staff, 403 forbidden, 401 unauthenticated); StaffMeProvider reads
// /admin/me. The fixture router answers both, so what the card shows is the authorized branch the real gate
// resolved to — point the fixture at a 403 and this same component renders its forbidden state.
import { AdminShell, TenantsPage } from "@leadwolf/ui";

/** The console as staff see it: gate passed, chrome mounted, the tenant directory loaded inside. */
export const Console = () => (
  <div style={{ height: 900, overflow: "hidden", borderRadius: 8 }}>
    <AdminShell>
      <TenantsPage />
    </AdminShell>
  </div>
);
