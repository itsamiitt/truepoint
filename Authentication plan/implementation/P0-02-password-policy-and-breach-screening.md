# P0-02 — Enforced password policy + breached-password screening

## Goal

Bring password handling up to **NIST SP 800-63B-4** (the 2025 revision): a real minimum length, **no** forced
composition/rotation, and **screening every new password against a breached-and-common list** — which 800-63B-4
makes a **SHALL** ([NIST SP 800-63B-4](https://pages.nist.gov/800-63-4/sp800-63b.html), and
[OWASP ASVS 5.0 V6](https://github.com/OWASP/ASVS/blob/master/5.0/en/0x15-V6-Authentication.md)). This is the
P0-wave item raised to High in the gap analysis (doc 06, decision D3b).

## Current state (confirm before editing)

Passwords are set in three paths, all funnelling through `hashPassword` (`packages/auth/src/password.ts`):
- **Registration** — `packages/auth/src/registration.ts` (`provisionIdentity`).
- **Reset** — `packages/auth/src/passwordReset.ts` (`completePasswordReset`).
- **Change** — not built yet (lands with P1-02 `/account/security`).

Today the only check is a length floor in the edge action (`apps/auth/src/app/reset/actions.ts` validates
`min 8`; registration likely mirrors it — `‹confirm›`). There is **no** breached-password screening and **no
single** server-side strength gate, so the floor is enforced inconsistently and bypassable by calling the
function directly.

## Design

A single server-side gate in `packages/auth`, called by every set-password path (so the client floor becomes
UX, not the boundary — truepoint-security: "the UI is not security"):

```ts
// packages/auth/src/passwordPolicy.ts (new)
// NIST SP 800-63B-4: length is the primary control; no composition rules; screen against breached/common.
export const PASSWORD_MIN_LENGTH = 12;   // ≥8 SHALL; 12–15 recommended. (Pre-tenant default; a tenant policy
                                          // may RAISE it later via tenant_auth_policies — see P1-01.)
export const PASSWORD_MAX_LENGTH = 128;   // accept long passphrases; cap only to bound hashing cost.

export type PasswordRejection = "too_short" | "too_long" | "breached";

export function validatePasswordShape(pw: string): PasswordRejection | null {
  if (pw.length < PASSWORD_MIN_LENGTH) return "too_short";
  if (pw.length > PASSWORD_MAX_LENGTH) return "too_long";
  return null; // NO composition/complexity rules by design (800-63B-4)
}
```

### Breach screening via HIBP k-anonymity (privacy-preserving)

The password (and its full hash) **never leaves the server**. SHA-1 the candidate, send only the **first 5 hex
chars** of the hash to the Pwned Passwords range API, and match the returned suffixes locally
([HIBP range API / k-anonymity](https://haveibeenpwned.com/API/v3#PwnedPasswords)):

```ts
// packages/auth/src/breachCheck.ts (new)
import { createHash } from "node:crypto";

const HIBP_RANGE = "https://api.pwnedpasswords.com/range/"; // FIXED host — not attacker-influenced
const TIMEOUT_MS = 1500;

// Returns true if the password appears in a breach corpus. FAIL-OPEN: a HIBP outage/timeout must not block
// account creation/reset (availability > this single control; mirrors the rate-limiter fail-open posture).
// Opt-in: disabled (returns false) if breach screening is turned off, like Turnstile's opt-in gate.
export async function isPasswordBreached(pw: string): Promise<boolean> {
  const sha1 = createHash("sha1").update(pw, "utf8").digest("hex").toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${HIBP_RANGE}${prefix}`, {
      headers: { "Add-Padding": "true" }, // padding hides the real count from a network observer
      signal: ctrl.signal,
    });
    if (!res.ok) return false; // fail-open
    const body = await res.text();
    return body.split("\n").some((line) => line.split(":")[0]?.trim() === suffix);
  } catch {
    return false; // fail-open on timeout/network error
  } finally {
    clearTimeout(t);
  }
}
```

### The combined gate

```ts
// packages/auth/src/passwordPolicy.ts
export async function assertPasswordAcceptable(pw: string): Promise<PasswordRejection | null> {
  const shape = validatePasswordShape(pw);
  if (shape) return shape;
  if (await isPasswordBreached(pw)) return "breached";
  return null;
}
```

Call `assertPasswordAcceptable` at the top of `provisionIdentity` (registration) and `completePasswordReset`
(reset) **before** `hashPassword`. Map the rejection to the existing auth error vocabulary (`errors.ts`) —
likely a `ValidationError` with a non-leaking, user-actionable message ("Choose a longer password" /
"That password has appeared in a data breach — choose another"). The edge keeps its client-side length hint for
UX.

## Notes / decisions baked in

- **Min length = 12** (above the 8 SHALL, below a friction wall). Pre-tenant default; P1-01 lets a tenant policy
  raise (never lower) it via `tenant_auth_policies` once enforcement on the authenticated paths lands.
- **Fail-open + opt-in** breach screening: a third-party (HIBP) outage must not break signup/reset; gate it on an
  env flag (e.g. `BREACH_CHECK_ENABLED`) so it can be disabled, mirroring `botCheck.ts`'s Turnstile opt-in.
- **No password history / rotation** — 800-63B-4 explicitly drops these; do not add them.

## Security checklist (truepoint-security)

- **Outbound (key one):** the only outbound call is to a **fixed, hard-coded** host (`api.pwnedpasswords.com`)
  — not an attacker-influenceable URL — so this is not the classic SSRF case, but still applies a **timeout**
  and treats the response as untrusted text. Do **not** make the host configurable from tenant input. (Ref
  `references/integrations.md`.)
- **Secrets / data exposure:** k-anonymity means the password and its full SHA-1 never leave the process; only
  a 5-char hash prefix is sent; `Add-Padding` hides the count. Never log the password or full hash.
- **Input:** `pw` is validated for length bounds before hashing (also caps Argon2 cost).
- **Abuse:** registration/reset are already Turnstile- + rate-limited; the HIBP call inherits that gating and
  has its own timeout, so it can't be used to amplify load.
- **Compliance:** no PII leaves; the control satisfies the 800-63B-4 / ASVS screening requirement an enterprise
  security review expects.

## Tests

- **Unit:** `validatePasswordShape` boundaries (11/12/128/129 chars); `assertPasswordAcceptable` returns
  `breached` when `isPasswordBreached` is stubbed true, `too_short` below the floor.
- **Unit (no network):** stub `fetch` — a matching suffix ⇒ breached; a non-`ok`/timeout ⇒ `false` (fail-open);
  assert only the 5-char prefix is sent and the full hash never is.
- **Integration:** `completePasswordReset` / registration reject a known-breached password (e.g. `"password"`)
  and accept a strong unique one; a forced HIBP failure still lets a shape-valid password through.

## Gates (run before commit)

```
bun run typecheck
biome check && biome format --write
bun run lint:boundaries
bun test packages/auth/src/passwordPolicy.test.ts packages/auth/src/breachCheck.test.ts
bun test packages/auth/src/passwordReset.test.ts   # + registration password tests
```

Branch e.g. `feat/auth-password-policy-breach-screening`. Flag the push step (no creds in this environment).
