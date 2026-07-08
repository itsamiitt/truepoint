# SSO integration — architecture decision brief

**Scope.** *How* enterprise SSO (SAML/OIDC) + SCIM plug into TruePoint's existing first-party auth. This is
**orthogonal to build-vs-buy** — the market/TCO question (WorkOS vs Auth0 vs Keycloak vs DIY) that the
`deep-research` pass answers picks *who fills the seam*; this brief defines *the seam*, which is the same either
way. Grounded in the code already on `feat/auth-platform-phase0`, not first principles.

## Recommendation: FEDERATE, don't replace

**The effective-policy engine is already built for federation.** In `policy.ts`:

```
isMethodAllowed(policy, method):  if (policy.requireSso && method !== "sso") return false
                                  return policy.allowedMethods.includes(method)
```

So `requireSso` already forces SSO as the only first factor, and `"sso"` is already an `AuthMethod` gated by
`allowedMethods`. And `finalizeLogin` (flow.ts) mints the first-party EdDSA access token + rotating refresh
**regardless of how the first factor was satisfied** — its authorization gates (`authorizeTenantSelection`,
the workspace-membership check) are method-agnostic. Nothing downstream of "the user proved who they are" cares
whether that proof was a password, a passkey, or a SAML assertion.

**Therefore the SSO adapter is a new FIRST-FACTOR identity source, not a new session system:**

```
IdP (SAML/OIDC)  ──►  SsoIdentity  ──►  JIT provision  ──►  login txn  ──►  finalizeLogin  (UNCHANGED)
  verify assertion     {email,          find/create        set userId,      → first-party tokens
  (WorkOS/DIY/          externalId,      user + tenant       tenantId,        → RLS GUCs, refresh
   Keycloak…)           connectionId,    membership          workspaceId}      rotation, revocation,
                        attributes}                                            the effective-policy engine
```

Everything to the right of `login txn` is the code we already built and hardened (Phase 2 token/session,
Phase 1 policy engine, the audit trail). SSO reuses it verbatim.

## The seam: a provider-agnostic `SsoIdentity`

Define ONE internal type the whole system depends on:

```ts
interface SsoIdentity {
  connectionId: string;   // which configured SSO connection (→ maps to exactly one tenant)
  email: string;          // MUST be provider-asserted-verified
  externalId: string;     // the IdP's stable subject (NameID / sub) — the join key, NOT email
  attributes?: Record<string, string>;  // for SCIM/role mapping
}
```

- **Buy (WorkOS/Scalekit/Auth0):** their SDK does the SAML/OIDC dance and hands back a profile → map to
  `SsoIdentity`. Days of work, no XML security to own.
- **Build (samlify / @node-saml + arctic for OIDC):** *we* own assertion validation — signature verify,
  **anti-XXE, anti-signature-wrapping, reject-unsigned** — the SAML footguns. Weeks, and it is the highest-risk
  security surface in the whole platform (a validation bug = full auth bypass). The research's CVE/maintenance
  findings should weigh heavily here.

Either way the seam and everything after it are identical — so this decision is **reversible**: start with a
vendor, swap in DIY later (or vice versa) behind the same `SsoIdentity`, with no change to `finalizeLogin`, the
token model, or the engine.

## Why not "replace"

Replacing the first-party session with the IdP's tokens/sessions throws away the entire Phase-2 hardening
(rotating refresh + reuse detection, revocation deny-list, `__Host-` cookie, brute-force lockout), the
RLS-integrated tenant/workspace claims, and the effective-policy engine — and couples every request to the IdP.
Not recommended. The value we've built lives in the first-party token; SSO should feed it, not supplant it.

## Ship-order + guardrails (all pre-existing seams)

1. **No-lockout guard FIRST** (Phase 4, plan's "ship first"): an org must NOT be able to set `require_sso=true`
   until a **test-connection** has proven its SSO works — else it locks itself out (no password, no working SSO).
   This is a `validatePolicyWrite`-adjacent check on the `require_sso` key (the key already exists in the engine).
2. **Connection → tenant is server-side.** Trust the IdP's *identity*, never its *tenant*: `connectionId` maps to
   exactly one tenant in our config; ignore any tenant claim in the assertion.
3. **Account-linking is the takeover surface** (same as social login): only auto-link an `SsoIdentity` to an
   existing password account when the email is provider-verified AND under an explicit policy — else an attacker
   who controls an IdP for a victim's email domain could adopt their account. Join on `externalId`, treat
   `email` as a hint.
4. **SCIM is a separate path** feeding the same user+membership model (provision/deprovision), decoupled from the
   auth flow — deprovision = revoke sessions (the revocation deny-list already exists).

## Bottom line

The engine was designed for this: `requireSso` + `allowedMethods` + a method-agnostic `finalizeLogin` mean SSO is
an additive first factor, not a rewrite. Decide **build-vs-buy from the research** (it only changes *who validates
the assertion*), implement the `SsoIdentity` seam + the no-lockout guard first, and everything downstream is the
hardened code already on this branch. **Flagged for review — this brief is the recommended integration shape, not
an approved build.**
