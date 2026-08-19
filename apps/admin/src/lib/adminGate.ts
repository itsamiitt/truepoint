// adminGate.ts — the staff-only authorization check layered on top of authClient (ADR-0011 / ADR-0034).
// A valid access token proves the caller signed in; it does NOT prove they are platform staff. The api
// `/admin/*` surface is gated on the signed `pa` claim and 403s a non-staff caller (platformAdmin guard), so
// the console verifies staff status by probing an `/admin/*` read. The console NEVER trusts a client-set
// flag — the api is the gate.
//
// The probe is `GET /admin/me`, and it returns its payload (perf-audit P0.9, porting apps/forge's forgeGate
// fix). It used to probe `GET /admin/system-health` and THROW THE BODY AWAY, purely to read the status code —
// and system-health is the single most expensive read on the admin surface: an audited withPlatformTx tally
// plus a fan-out probe of ~22 BullMQ queues over Redis, paid on EVERY staff page load before the console
// rendered (the System-health page then paid it a second time for the actual data). `/admin/me` is the right
// probe: it is the cheapest read on the surface (one indexed role lookup), it answers the same authorization
// question through the same pa-claim gate, and its body is exactly what StaffMeProvider needs next — so the
// shell seeds the provider from the verdict instead of fetching `/admin/me` a second time.

import type { StaffCapability } from "@leadwolf/types";
import { fetchWithAuth } from "./authClient";
import { API_BASE } from "./publicConfig";

export type AdminGateResult = "staff" | "forbidden" | "unauthenticated" | "error";

/** What `GET /admin/me` returns — the caller's active staff role + the capabilities it grants (13a F3). */
export interface StaffMePayload {
  staffRole: string | null;
  capabilities: StaffCapability[];
}

export interface AdminGateVerdict {
  result: AdminGateResult;
  /** Present only on a 200, so the shell can seed StaffMeProvider rather than repeating the read. */
  me?: StaffMePayload;
}

/** Probe `GET /admin/me` to classify the caller, returning the payload so it need not be fetched twice.
 *  A 200 with `staffRole: null` (a pa-claim holder without an active platform_staff row) classifies as
 *  `forbidden` — the api 403s their actual reads regardless; this only decides which shell state to render. */
export async function verifyPlatformAdmin(): Promise<AdminGateVerdict> {
  try {
    const res = await fetchWithAuth(`${API_BASE}/api/v1/admin/me`);
    if (res.ok) {
      const me = (await res.json()) as Partial<StaffMePayload>;
      const payload: StaffMePayload = {
        staffRole: me.staffRole ?? null,
        capabilities: Array.isArray(me.capabilities) ? me.capabilities : [],
      };
      return payload.staffRole
        ? { result: "staff", me: payload }
        : { result: "forbidden", me: payload };
    }
    if (res.status === 403) return { result: "forbidden" };
    if (res.status === 401) return { result: "unauthenticated" };
    return { result: "error" };
  } catch {
    return { result: "error" };
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
