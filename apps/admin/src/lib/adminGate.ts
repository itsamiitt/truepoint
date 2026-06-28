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

/**
 * Classify whether the caller holds the super_admin staff role, by probing a super_admin-ONLY read
 * (`GET /admin/staff` is gated by requireStaffRole("super_admin")): 200 ⇒ super_admin, 403 ⇒ staff but not
 * super_admin. Mirrors verifyPlatformAdmin's probe-the-api pattern (the client never trusts a self-set flag).
 *
 * RENDER-GATE ONLY. This is UX — it decides whether to show/enable the lockout-capable enforcement switch.
 * It is NOT a security boundary: the api re-checks requireStaffRole("super_admin") on the write itself, so a
 * tampered client can never flip enforcement. The response body is discarded (only the status is read).
 * Throws on a transient/unexpected status so the caller can surface a retryable error state.
 */
export async function verifySuperAdmin(): Promise<boolean> {
  const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/staff`);
  if (res.ok) return true;
  if (res.status === 403) return false;
  throw new Error(`Could not verify role (${res.status})`);
}
