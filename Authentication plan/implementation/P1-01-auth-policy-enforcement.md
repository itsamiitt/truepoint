# P1-01 — Auth-policy enforcement on login

## Goal

Make the `tenant_auth_policies` fields that are **stored and resolved but never gated** actually enforce at
login: **MFA enforcement** (with forced in-login enrollment), **allowed methods**, **IP allowlist**, and
**session timeout**. Today only `mfaEnforcement === "required"` is checked, at `flow.ts:152-160`, and it
*errors* the un-enrolled case (there's a `WIRE:` note to route to enrollment instead). `policy.ts`
(`resolveEffectivePolicy` / `isMethodAllowed`, strictest-wins) already computes the effective policy — the gap
is purely enforcement.

## ⚠️ This wave is lockout-capable — the cardinal rule

Every gate here can lock real users (or a whole org) out if mis-set. **Each sub-gate ships behind a per-tenant,
default-OFF feature flag with a documented break-glass disable path** (the existing feature-flag system —
`‹confirm the per-tenant flag API›`). Enable per tenant only after that tenant is verified. See the delivery-risk
register in [`../11-gap-register.md`](../11-gap-register.md) and the migration/backout requirement in
[`../08-roadmap.md`](../08-roadmap.md).

## Sub-gates

### A. Forced in-login MFA enrollment (unblocks `mfaEnforcement: required`)

Replace the `ForbiddenError("mfa_required")` at `flow.ts:155` with a routed step. When `policy.mfaEnforcement
=== "required"` and `!txn.mfaVerified` and the user has **no** enrolled method, return a `LoginStep` of
`"mfa_enroll"` (extend the `LoginStep` union, `flow.ts:22`) so `apps/auth` shows a new `/mfa/enroll` screen
instead of erroring.

- **`apps/auth/src/app/mfa/enroll/`** *(new)*: generate a TOTP secret (`@oslojs/otp`; `mfa.ts` has verify —
  add generate + the `otpauth://` URI + a QR), show it, verify the first code, persist `user_mfa_methods`
  (secret via `secrets.ts`), generate + show **recovery codes once**, then continue the login transaction.
- **Security ACs (ship gate) → [`../09-threat-model.md`](../09-threat-model.md) "MFA integrity (downgrade &
  enrollment trust)":** bind enrollment to the partially-authenticated login transaction (the user proved the
  primary factor this same flow); re-prove the primary factor around the enroll write; rate-limit + audit
  enrollment; the new TOTP secret must bind to the right `userId` (from the txn, never the request).

### B. Allowed-methods gate

`isMethodAllowed` (`policy.ts:52`) exists; carry the **method used** in the login transaction
(`loginTransaction` — add `method: AuthMethod`) and enforce at `finalizeLogin` once the tenant is resolved
(`flow.ts:145`, post `authorizeTenantSelection`): if the resolved tenant's `allowedMethods` excludes the
method, throw `ForbiddenError("method_not_allowed")`. Enforce **after** tenant resolution because the policy is
per-tenant and the method is chosen pre-tenant.

### C. IP allowlist gate

At `finalizeLogin` (tenant resolved), if `policy.ipAllowlist` is non-empty and `txn.clientIp` (already on the
txn) is **not** in any CIDR, throw `ForbiddenError("ip_not_allowed")`. Add a small CIDR-match util
(`packages/auth/src/ipAllowlist.ts`) — reuse the normalization already in `ipBinding.ts` (IPv4-mapped IPv6,
zone-id stripping). **AC:** match by CIDR network, never string equality (the gap analysis flagged this exact
trap); a malformed policy entry fails **closed for that entry**, not open for all.

### D. Session timeout

`policy.sessionTimeoutSeconds` caps session lifetime. Enforce in two places:
- **`createSession`** (`session.ts`): cap `expiresAt` at `min(default, now + sessionTimeoutSeconds)`.
- **`refresh`** (`refresh.ts`): reject (force re-auth) when the session exceeds the **absolute** cap or the
  **idle** window since `lastSeenAt`. Make the idle-vs-absolute boundary explicit (the AC the gap analysis
  asked for). Resolve the effective timeout per the session's tenant (strictest-wins, `policy.ts`).

## `require_sso` (sequencing guard — do NOT enable before P2)

`require_sso` is part of the policy but its enforcement must **not** precede the real SSO adapters (P2): the
gate would route users to a handoff that throws (`providers.ts` Stub). Build the gate behind a per-tenant flag
default-off; the concrete guard: **reject enabling `require_sso` for a tenant while
`getSsoProvider(protocol)` returns the throwing Stub adapter** (i.e. only allow the flip once that tenant's
adapter passes a test-connection). This is the same per-tenant-flag resolution doc 08 P1a/sequencing notes
require.

## Security checklist (truepoint-security)

- **Authorization:** every gate runs server-side at `finalizeLogin` (the authoritative token gate), never the
  client. Methods/IPs/timeouts come from the **resolved** tenant policy, not request input.
- **Identity:** holds for SSO/SCIM users (policy is per-tenant; the resolved tenant is membership-checked at
  `flow.ts:145/165`). Forced enrollment binds to the txn identity.
- **Abuse / lockout:** the default-off per-tenant flags + break-glass are the control; a mis-set policy must be
  reversible without a deploy. Enrollment + failed-gate attempts are rate-limited (reuse `rateLimit.ts`).
- **Input:** CIDR entries and method names are validated against the existing Zod policy schema before use.
- **Compliance:** emit the matching audit events (`login.locked` / `mfa.challenge` etc.) via the P0-01 sink as
  those flows land.

## Tests

- Unit: `isMethodAllowed` gate truth table; CIDR match (in/out/edge, IPv6-mapped); session-timeout cap math
  (idle vs absolute).
- Integration: a `required`-MFA org with an un-enrolled user is routed to `/mfa/enroll` (not errored) and
  completes; a disallowed method / out-of-allowlist IP / expired session is rejected at finalize; **with the
  per-tenant flag OFF, none of the gates fire** (the safety property).

## Gates

```
bun run typecheck && biome check && bun run lint:boundaries
bun test packages/auth/src/policy.test.ts packages/auth/src/ipAllowlist.test.ts
bun test packages/auth/src/flow.test.ts            # finalize enforcement + flag-off safety
```

Branch e.g. `feat/auth-policy-enforcement`. Land the sub-gates incrementally (A→D), each behind its own flag.
