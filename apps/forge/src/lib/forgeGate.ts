// forgeGate.ts — the staff-only authorization check layered on top of authClient (ADR-0011 / ADR-0034),
// the Forge counterpart to apps/admin's adminGate. A valid access token proves the caller signed in; it does
// NOT prove they may operate Forge. The console NEVER trusts a client-set flag — the forge-api is the gate,
// and it re-checks every capability server-side on every request regardless of what this returns.
//
// The probe is `GET /bff/me`, and it returns its payload (T-2.5).
//
// It used to probe `GET /bff/overview` and THROW THE BODY AWAY, purely to read the status code. Cold load was
// therefore: refresh → overview-as-probe (discarded) → /bff/me for identity → overview again for the data.
// Three `/bff/*` calls, each doing its own uncached `platform_staff` lookup, to render one page — and the
// most expensive of the three was the one whose result was discarded.
//
// `/bff/me` is the right probe because it is authn-only and cheap, and it already returns exactly what the
// console needs next: role, capabilities and email. Returning it lets StaffMeProvider be seeded instead of
// re-fetching, so the sequence becomes refresh → /bff/me → overview: two staff lookups instead of three, and
// nothing fetched twice.

import type { StaffCapability } from "@leadwolf/types";
import { fetchWithAuth } from "./authClient";
import { API_BASE } from "./publicConfig";

export type ForgeGateResult =
  | "staff"
  | "forbidden"
  | "unauthenticated"
  | "misrouted"
  | "unavailable";

/** What `/bff/me` returns — the caller's own role, capability matrix and directory identity. */
export interface StaffMePayload {
  staffRole: string | null;
  capabilities: StaffCapability[];
  email: string | null;
}

export interface ForgeGateVerdict {
  result: ForgeGateResult;
  /** Present only on a 200, so the shell can seed StaffMeProvider rather than repeating the read. */
  me?: StaffMePayload;
}

/**
 * The capability the console's landing surface actually needs. The previous gate probed `/bff/overview`,
 * which is `data:read`-gated, so "can this caller read data" WAS the verdict. Classifying on the same
 * capability keeps the behaviour identical: a signed-in non-staff user (200 with an empty matrix) and a
 * zero-capability staff account both resolve to `forbidden`, exactly as overview's 403 did.
 */
const CONSOLE_CAPABILITY: StaffCapability = "data:read";

/** Probe `/bff/me` to classify the caller, returning the payload so it need not be fetched twice. */
export async function verifyForgeStaff(): Promise<ForgeGateVerdict> {
  try {
    const res = await fetchWithAuth(`${API_BASE}/bff/me`);
    if (res.ok) {
      const me = (await res.json()) as Partial<StaffMePayload>;
      const capabilities = Array.isArray(me.capabilities) ? me.capabilities : [];
      const payload: StaffMePayload = {
        staffRole: me.staffRole ?? null,
        capabilities,
        email: me.email ?? null,
      };
      // Authorization is still the server's: this only decides which SHELL STATE to render. The forge-api
      // 403s the actual reads regardless of what we conclude here.
      return capabilities.includes(CONSOLE_CAPABILITY)
        ? { result: "staff", me: payload }
        : { result: "forbidden", me: payload };
    }
    if (res.status === 403) return { result: "forbidden" };
    if (res.status === 401) return { result: "unauthenticated" };
    // 404/405 = the origin answered but the BFF route is not there (a stale deploy or edge config still
    // sending /bff/* to the Next console). Not a connectivity problem, and it gets distinct copy.
    if (res.status === 404 || res.status === 405) return { result: "misrouted" };
    return { result: "unavailable" };
  } catch {
    return { result: "unavailable" };
  }
}
