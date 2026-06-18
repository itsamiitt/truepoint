// adminGate.ts — the staff-only authorization check layered on top of authClient (ADR-0011 / ADR-0034).
// A valid access token proves the caller signed in; it does NOT prove they are platform staff. The api
// `/admin/*` surface is gated on the signed `pa` claim and 403s a non-staff caller (platformAdmin guard), so
// the console verifies staff status by probing a cheap `/admin/*` read: 200 ⇒ staff, 403 ⇒ signed in but not
// staff, 401 ⇒ no/again-expired token. The console NEVER trusts a client-set flag — the api is the gate.

import { fetchWithAuth } from "./authClient";
import { API_BASE } from "./publicConfig";

export type AdminGateResult = "staff" | "forbidden" | "unauthenticated" | "error";

/** Probe the platform-admin surface to classify the caller. Uses the cheap system-health read. */
export async function verifyPlatformAdmin(): Promise<AdminGateResult> {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/system-health`);
    if (res.ok) return "staff";
    if (res.status === 403) return "forbidden";
    if (res.status === 401) return "unauthenticated";
    return "error";
  } catch {
    return "error";
  }
}
