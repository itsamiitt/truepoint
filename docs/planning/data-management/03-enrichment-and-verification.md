# 03 — Enrichment & Verification (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM8 and `01-research-brief.md §2.2/§5.2/§5.3`.
> **Posture:** reuse the shipped waterfall; **design the verification subsystem** (the real gap — no
> verifier is wired today). **No code changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| Waterfall: providers ordered `trust / max(1,cost)`, first-hit-wins | `@leadwolf/core` `enrichment/waterfall.ts:51-60,69-86` |
| Per-process circuit breaker (3 errors → open 60s) | `enrichment/waterfall.ts:8-43` |
| Bulk parallel waterfall (cheap race, expensive sequential) | `enrichment/waterfall.ts:117-174` |
| Provider interface + adapters (Apollo/ZoomInfo/Clearbit) | `06-enrichment-engine.md §3`; `@leadwolf/integrations` `enrichment/providers.ts:44-104` |
| Request cache (SHA-256 `requestHash`, `(workspaceId,requestHash)`) + daily budget breaker | `enrichment/requestHash.ts`; `enrichment/enrichContact.ts:121-135` |
| Charge-on-reveal (enrichment is a system cost) | `06 §1`; `07-billing-credits.md` |
| Charge-by-verified-result (0 credits on invalid/catch_all/unknown) | `data-health/chargeFor.ts:18-34` |
| Bulk enrichment job + ledger | ADR-0039; `enrichmentJobs` schema |
| Match-against vs contribute-to (co-op OFF) | `06 §1`; ADR-0021 |

**Conclusion:** the enrichment *engine* (waterfall, cache, budget, charge policy) is built. The
**verifier the charge policy presupposes is not** — `chargeFor` keys off an `EmailStatus` that today
is never graded (`passThroughVerifier` returns the stored status, `emailVerifier.ts:14-18`).

## 2. Net-new (design here): the verification subsystem

### 2.1 Why now

`chargeFor` already gives 0 credits for `invalid`/`catch_all`/`unknown` and full for `valid`
(`chargeFor.ts:18-34`) — but with the pass-through verifier every status stays as imported, so the
"pay only for valid data" promise (ADR-0013) is **not actually enforced**. Verification is the trust
wedge; this designs the real `EmailVerifierPort` + a phone line-type port behind it.

### 2.2 Email verifier — hybrid (DM8)

A real `EmailVerifierPort` (the seam exists: `emailVerifier.ts:9-12`) graded by a **dedicated**
verifier so a data provider never grades its own answer (ADR-0013). Strategy (per `01 §5.2`):

- **Reacher (self-host) for honest-responding domains.** syntax → MX → SMTP `RCPT TO` (never sends);
  returns `is_reachable ∈ {safe,risky,invalid,unknown}` + `smtp.*`. Map → `EmailStatus`:
  `safe→valid`, `invalid→invalid`, `is_catch_all→catch_all`, `unknown/is_disabled→unknown`,
  role/disposable/full-inbox → `risky`.
- **Commercial verifier for the cases Reacher structurally can't resolve** — **catch-all**
  (~28-40% of B2B; SMTP can only *flag* it), Gmail (`disabled`), Yahoo (always 250), M365/SEG
  greylisting. A commercial verifier adds non-SMTP signals (historical send, domain-behaviour) to
  resolve some of these. Route to it **only** when Reacher returns `catch_all`/`unknown` — keeps
  metered spend bounded.
- **Operational constraints (must be designed for, `01 §5.2`):** outbound port 25 (blocked on most
  clouds → use an SMTP proxy / dedicated egress), forward-confirmed PTR/rDNS, rotating IPs;
  **isolate verification IPs from sending IPs** so probe-driven blocklisting can't degrade outbound
  mail. AGPL-3.0 (commercial license) for Reacher.
- **Catch-all rule (DM8):** a catch-all is **never** billed as `valid`; it is `catch_all` → 0 credits
  (`chargeFor.ts`) unless the commercial pass resolves it to `valid`.

### 2.3 Phone line-type port

Today `validatePhone` is an **E.164 regex only** (`validatePhone.ts:7-12`); the `direct/mobile/hq`
line types and `PhoneStatus` need a **line-type lookup provider** (e.g. Twilio Lookup / Telnyx).
Design a `PhoneLineTypePort` mirroring the email verifier seam that populates line type + carrier.
This is **also the input to the TCPA line-type gate** in `05-compliance.md §TCPA` — the same lookup
serves verification (data health) and compliance (consent gating). Do not duplicate it.

### 2.4 Wiring

- Verification runs **outside** the DB tx (network I/O), then updates `emailStatus`/`phoneStatus` +
  `lastVerifiedAt` (mirrors the reveal path `revealContact.ts`).
- Results carry **channel provenance** → `04-provenance.md` (`revealed_channels`, Phase 4) and feed
  `chargeFor`.
- A bounce/complaint from the send pipeline auto-adds a suppression row (`08 §6`) — unchanged.

## 3. Target schema

No new top-level tables for email verification (statuses already exist:
`EmailStatus`/`PhoneStatus` enums + DB CHECK on `contacts`). Additive:

| Table | Add | Rule |
|---|---|---|
| (verifier config) | reuse `provider_configs` / `enrichment_policy` pattern for verifier vendor + thresholds | per-workspace; values config-injected, never hardcoded |
| `revealed_channels` (Phase 4) | per-channel `status`, `verification_source`, `last_verified_at` | channel provenance home (`04`); seam reserved now |

## 4. RLS / scoping implications

Verification reads/writes overlay rows under `withTenantTx` (FORCE-RLS, DM4). Provider/verifier API
keys are **server-side secrets** (never on the client; `truepoint-security`). The verifier is
provider-independent (no data provider grades its own answer, ADR-0013).

## 5. Scale-gate analysis

| Breaks first | Why | Fix |
|---|---|---|
| Verifier throughput (SMTP probes) | port-25 rate limits + greylisting cap per-IP throughput | rotating IP pool + SMTP proxy; async job with backpressure; cache results (re-verify at point of use, not per send) |
| Commercial-verifier spend | catch-all routing could fan out cost | route to commercial **only** on Reacher `catch_all`/`unknown`; daily budget breaker (reuse `enrichContact.ts:125-135`) |
| Re-verification at scale | B2B decay ~2.1%/mo → stale statuses | reuse the freshness/decay re-verification loop (`prospect-company-data` PLAN_06; `22`) — don't reinvent |

## 6. Failure modes

- **F1 — catch-all billed as valid:** prevented by DM8 + `chargeFor` (catch_all → 0).
- **F2 — verification IP blocklisting degrades outbound mail:** isolate verifier IPs from sending IPs
  (§2.2).
- **F3 — verifier grades its own provider's answer:** prevented by the dedicated-verifier rule
  (ADR-0013); the verifier is never the same vendor that sourced the value.
- **F4 — double charge on retry:** request cache + idempotent `requestHash` (reused).

## 7. Open questions

1. **Commercial verifier vendor** (ZeroBounce/NeverBounce/Kickbox-class) — owner: `truepoint-operations`
   (cost) + security (DPA). The *hybrid shape* is locked (DM8); the vendor is not.
2. **Phone line-type provider** (Twilio Lookup vs Telnyx) and whether it ships with the dialer or
   earlier for data-health. Shared with `05 §TCPA`.
3. Verifier egress topology (SMTP proxy vs dedicated NAT egress) — owner: platform/ops.
