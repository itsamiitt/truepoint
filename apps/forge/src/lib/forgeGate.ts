// forgeGate.ts — the staff-only authorization check layered on top of authClient (ADR-0011 / ADR-0034),
// the Forge counterpart to apps/admin's adminGate. A valid access token proves the caller signed in; it does
// NOT prove they may operate Forge. The forge-api `/bff/*` surface is gated on the signed `pa` claim and 403s a
// non-staff caller, so the console verifies staff status by probing a cheap `data:read` BFF read
// (`GET /bff/overview`): 200 ⇒ staff, 403 ⇒ signed in but not staff, 401 ⇒ no/again-expired token. The console
// NEVER trusts a client-set flag — the forge-api is the gate.

import { fetchWithAuth } from "./authClient";
import { API_BASE } from "./publicConfig";

export type ForgeGateResult = "staff" | "forbidden" | "unauthenticated" | "error";

/** Probe the forge-api BFF overview read to classify the caller. Uses the cheap data:read surface. */
export async function verifyForgeStaff(): Promise<ForgeGateResult> {
  try {
    const res = await fetchWithAuth(`${API_BASE}/bff/overview`);
    if (res.ok) return "staff";
    if (res.status === 403) return "forbidden";
    if (res.status === 401) return "unauthenticated";
    return "error";
  } catch {
    return "error";
  }
}
