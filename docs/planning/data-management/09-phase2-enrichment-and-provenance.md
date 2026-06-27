# 09 — Phase 2: Enrichment & Provenance (execution spec)

> **Gate:** PLAN / execution spec. **Posture:** reconcile-and-cite — confirm what is shipped, correct
> the incoming brief's premises against the code, map its proposed schema onto the real model, and
> scope the genuine net-new by **citing existing designs**. **Converts** the incoming brief
> *"03 — Phase 2: Enrichment & Provenance."* Builds on data-management `03-enrichment-and-verification.md`
> + `04-provenance.md`. **Depends on** Phase 1 (`08`) for stable identity. **No source code is modified
> by this gate.**

## 1. Objective (and how much already exists)

The brief asks for a waterfall enrichment engine that fills + verifies fields, attaches field-level
provenance to every value, runs SSRF-safe, and re-enriches on a freshness cadence — on identifiers,
never leaking raw tenant lists to the shared graph.

**The engine and the provenance substrate already ship** (§3). The brief's SSRF controls are **already
the architecture** (hardcoded vendor adapters; no admin-settable URL; §2/§6). The genuine gaps are the
**verifier subsystem** and the **freshness re-enrichment loop** — both already *designed* and cited
here (§5), not redesigned.

## 2. Premise corrections (reported refuted, with `file:line`)

| Brief premise | Verdict | Evidence |
|---|---|---|
| "runs safely (no SSRF)" implies an enrichment SSRF surface to close | **No surface exists** | provider endpoints are **hardcoded vendor adapters** (`integrations/.../providers.ts:50,71,91`); `provider_configs` (`schema/intel.ts:120-127`) has **no endpoint URL** (only `enabled`/`rate_limit_per_min`/`monthly_budget_cents`/`label`); keys live in env/KMS. An admin **cannot** enter an arbitrary URL. |
| "reject private/internal IPs + metadata endpoint" (mandatory control) | **Already shipped where needed** | `webhooks/ssrfGuard.ts` rejects RFC-1918 / loopback / link-local / metadata `169.254.169.254` / IPv6-private / IPv4-mapped / NAT64, at create **and** dispatch. The real residual is the webhook **DNS-rebind TOCTOU** (`ssrfGuard.ts:11-14`, R4) — not enrichment. |
| Provenance: "B — normalized `core.field_provenance` table … recommended A + B async-mirror" | **Contradicts a locked decision** | the normalized side table was **considered and rejected**; the substrate is the **JSONB winner-map** (BRAINSTORM_03 → Substrate C; PLAN_03; `04` DM6). Lineage / GDPR Art.14 "source" is served by **Layer-0 `source_records` + `lawful_basis_snapshot`**, not an overlay mirror. |
| "A waterfall enrichment engine that fills and verifies fields" (to build) | **Engine already built** | `enrichment/waterfall.ts` (trust÷cost, circuit breaker, bulk race); BullMQ `enrichment` worker; `provider_calls` cache + daily budget breaker. |

## 3. Current state — the shipped enrichment + provenance

- **Waterfall** (`enrichment/waterfall.ts`): providers ordered `trust / max(1,cost)` (`:51-60`),
  first-hit-wins (`:69-86`); per-process **circuit breaker** (3 errors → 60s, `:8-43`); **bulk** mode
  races cheap providers, runs expensive sequentially (`:117-174`).
- **Providers** (`integrations/.../providers.ts`): apollo/zoominfo/clearbit **hardcoded** `url:`
  adapters over `httpProvider`; keys from `env`; absent key → permanent `miss` (never throws).
- **Cost/cache/budget**: `provider_calls` request-hash cache + cost ledger (`schema/intel.ts`);
  `enrichContact.ts` daily platform budget breaker (`:125-135`) + per-workspace `enrichment_policy`
  (triggers / `field_allowlist` / `monthly_budget_micros`); `provider_configs` per-provider
  `enabled` (kill-switch) + `rate_limit_per_min` + `monthly_budget_cents`.
- **Provenance**: `field_provenance` JSONB winner-map on `contacts`/`accounts`
  (`types/fieldProvenance.ts`); `enrichContact.ts:169-193` plans the write via `planFieldWrite`,
  drops **pinned** scalars (human edits win), stamps `{src:'provider:…'}` on what it writes.
- **Charge-for-verified**: `data-health/chargeFor.ts:18-34` — `valid` charges; `invalid`/`catch_all`/
  `unknown` → **0 credits**; phone charges only on a resolved line type.
- **Identifiers, not raw lists**: import/enrichment resolve via `resolveForImport` under **`withErTx`**
  (`leadwolf_er`, no overlay grant); **MATCH-AGAINST always-on**, **CONTRIBUTE-TO (co-op) off by
  default** (ADR-0021; `runImport.ts:202-222`) — a tenant's list never feeds the shared graph.

## 4. Brief → real-model mapping (do not fork the schema)

| Brief artifact | Real model | Where |
|---|---|---|
| `core.field_provenance` (entity, field, source, value, confidence, observed_at, license, run_id) | `field_provenance` JSONB winner-map `{src,mth,conf,obs,ver,pin,by,at}` **+** Layer-0 `source_records` lineage (`lawful_basis_snapshot` = the "license"/basis) | `types/fieldProvenance.ts`; `04 §2.2`; ADR-0003/0021 |
| `enrich.provider` (name, endpoint, cost, rate, health, kill_switch) | hardcoded adapters (`providers.ts`) + `provider_configs` (enabled/rate/budget) — **endpoint is code, not data** | `providers.ts`; `schema/intel.ts:120-127` |
| `enrich.run` (waterfall execution record) | `provider_calls` (per-call cost/cache/status) + `enrichment_jobs` (bulk ledger) | `schema/intel.ts`; ADR-0039 |
| `verify.email_result` / `verify.phone_result` | `email_status`/`phone_status` enums + `revealed_channels` channel provenance (Phase 4) | `types/contacts.ts`; `04 §2.1` |
| `resolveField(field, identity, chain, budget)` | the `waterfall` port + `enrichContact` flow | `enrichment/waterfall.ts`, `enrichContact.ts` |

**Do not introduce `core.*`/`enrich.*`/`verify.*` tables** — they fork the shipped model.

## 5. The genuine net-new (cite the existing design)

> **Implementation status (2026-06-27):** the **email** verifier is now partially built — a config-gated
> `defaultEmailVerifier()` + the `reacherVerifier` HTTP adapter (injectable fetch) + the pure
> `hybridVerifier` composer + the reveal-path wiring landed (`packages/core/src/data-health/reacherVerifier.ts`,
> `emailVerifier.ts`, `apps/api/src/features/reveal/routes.ts`; `REACHER_BACKEND_URL`/`REACHER_API_TOKEN`
> in `packages/config/src/env.ts`). Absent config → unchanged passthrough. **Still pending:** the
> commercial-verifier secondary (vendor open, §7) and the phone line-type port (§2.3).

1. **Verifier subsystem** — a real `EmailVerifierPort` replaces `passThroughVerifier`
   (`data-health/emailVerifier.ts:14-18`): **hybrid** Reacher (honest domains) + a commercial verifier
   for catch-all/Gmail/Yahoo; catch-all is flagged `risky`/`catch_all` and **never billed valid**
   (DM8). A **phone line-type port** populates `direct/mobile/hq` (today `validatePhone.ts:7-12` is
   E.164-regex only) — the **same lookup** feeds the TCPA line-type gate (`05 §TCPA`). → cite
   data-management `03 §2` + `01 §5.2/§5.3` (already verified — no new research).
2. **Freshness / re-enrichment loop** — `last_verified_at` exists but **nothing re-verifies on
   cadence** (no `verification_jobs` table / re-verify worker). Build the per-channel freshness +
   decay-priority + in-use-gated re-verification loop → cite `prospect-company-data` **PLAN_06** +
   **ADR-0025** (per-field cadence: emails decay faster than firmographics). Reuse the existing
   `enrichment` worker topology + `provider_calls` cache; re-verify **at point of use**, not blindly.
3. **Provenance lineage / GDPR Art.14 "source"** — the brief's "B" use case (query "all fields from
   source X" / license revocation) is served by **Layer-0 `source_records`** (immutable per-source
   evidence) + `source_records.lawful_basis_snapshot`, read via the privileged/compliance path — **not**
   a normalized overlay mirror (which BRAINSTORM_03 rejected). The hot read path is the JSONB
   `field_provenance` on the row. → cite `04 §2.2`, ADR-0003/0021, `05 §2` (Art.14 source-notice).

## 6. SSRF & safety (reconciled to the shipped architecture)

- **Allowlist only / no arbitrary URLs** — satisfied by **hardcoded vendor adapters**; `provider_configs`
  carries no URL. Adding a provider is a code change (a reviewed adapter), not admin data entry.
- **Private/internal-IP + metadata rejection** — the control exists in `ssrfGuard.ts` and applies to the
  surface that *is* user-controlled (customer **webhook** URLs), at create + dispatch. Enrichment never
  fetches a record/tenant-controlled URL, so it needs no per-call SSRF check. **Residual to track:**
  webhook DNS-rebind TOCTOU (R4) → connect-by-pinned-IP follow-up.
- **Per-provider budget cap + kill-switch** — `provider_configs.monthly_budget_cents` + `rate_limit_per_min`
  + `enabled`, plus the global daily breaker (`enrichContact.ts:125-135`) and per-workspace
  `enrichment_policy.monthly_budget_micros`. Disabling a provider is a config write (no deploy).
- **Identifiers, not raw lists; separate code paths** — MATCH-AGAINST runs under **`leadwolf_er`**
  (`withErTx`), tenant overlay writes under **`leadwolf_app`** (`withTenantTx`), platform/shared-graph
  writes under **`withPrivilegedTx`** — **physically separate roles/grants** (ADR-0021; `01 §3.5`).
  CONTRIBUTE-TO (co-op) is **off by default**, so tenant data never enters the shared graph.

## 7. Migration & rollout (reconciled)

- **Expand** — additive `verification_jobs` (owned by `03`/ADR-0025); the waterfall, providers,
  `field_provenance`, `provider_configs` already exist.
- **Shadow** — run the verifier/freshness loop in dry-run, logging would-be status changes + cost,
  before any write; reconcile against `chargeFor` expectations.
- **Backfill** — re-verify stale-flagged records in bounded off-peak batches via the new re-verify
  worker (reuse the `enrichment` queue + `provider_calls` cache).
- **Cutover** — enable per-workspace via `enrichment_policy` triggers (`on_stale`) / feature flags;
  watch fill-rate + cost dashboards (`18 §2` async-freshness SLOs).
- **Rollback** — `provider_configs.enabled=false` (per-provider kill-switch, no deploy) + the feature
  flag disables the loop; provenance/charge are unaffected.

## 8. Gate-compliance checklist (mapped to real mechanisms)

- [x] **Tenant isolation** — shared-graph writes (`leadwolf_er`/`withPrivilegedTx`) vs tenant overlay
  writes (`leadwolf_app`) are separate roles; no tenant list reaches admin enrichment (co-op off).
- [ ] **Bounded queries** — stale-field selection must be batched + indexed (the freshness loop's
  responsibility; design in `03`/ADR-0025).
- [x] **Pool safety** — provider I/O in the `enrichment` BullMQ worker; DB writes short; daily breaker
  + per-tenant concurrency.
- [x] **Online-safe migrations** — `verification_jobs` additive; backfill batched.
- [x] **Cache correctness** — `provider_calls` request-hash cache (idempotent); enrichment/reveal caches
  invalidate-on-write via the event backbone (`18 §5`).
- [x] **SSRF** — allowlist (hardcoded adapters) + internal-IP/metadata rejection (`ssrfGuard`, webhooks)
  enforced and tested; enrichment has no URL surface.

## 9. Acceptance criteria (reconciled — already-met vs net-new)

- [x] **Every *written* enriched field has provenance** (`field_provenance` stamped on write,
  `enrichContact.ts:169-193`).
- [x] **SSRF: internal IPs + metadata endpoint blocked** (`ssrfGuard.ts`, the user-controlled webhook
  surface); enrichment has no arbitrary-URL surface.
- [x] **Per-provider budget cap + kill-switch** (`provider_configs` + daily breaker).
- [ ] **Email/phone verification wired** (verifier subsystem, §5.1) — net-new.
- [ ] **Fill-rate + cost dashboards live** + freshness re-enrichment running (§5.2) — net-new.
- [ ] **Catch-all policy** explicit — already: `chargeFor` treats `catch_all` as 0-credit (never billed
  valid); the accept/flag/reject UX is the remaining product decision.

## 10. Scale-gate · Failure modes · Open questions

**Scale-gate:** verifier throughput (SMTP port-25 limits/greylisting) → async job + rotating-IP proxy,
isolate verifier IPs from sending IPs (`03 §5`); re-verification volume at decay scale → budgeted
decay-priority queue (PLAN_06).

**Failure modes:** (F1) **provenance write-amplification — moot**: the JSONB winner-map is a single
co-located column, *not* an async-mirrored side table, so the brief's "mirror lag bounds" risk does not
arise. (F2) catch-all billed as valid → prevented by `chargeFor` (catch_all = 0). (F3) verifier grades
its own provider's answer → prevented by the dedicated-verifier rule (ADR-0013). (F4) verification IP
blocklisting degrades outbound mail → isolate verifier IPs (`03 §2.2`).

**Open questions:** (1) Freshness cadence per field-type (emails vs firmographics) — owner: ADR-0025 /
`22`. (2) Catch-all accept/flag/reject **UX** policy — owner: product (the billing side is settled).
(3) Commercial verifier vendor + phone line-type provider — owner: `truepoint-operations` (the hybrid
*shape* is locked, `03 §7`). (4) Webhook DNS-rebind TOCTOU (R4) close-out — owner: security.

## Sources

Code (verified): `packages/core/src/enrichment/{waterfall,enrichContact,requestHash}.ts`,
`packages/integrations/src/enrichment/providers.ts`, `packages/db/src/schema/intel.ts`
(`provider_configs:120-127`), `packages/core/src/data-health/{emailVerifier,validatePhone,chargeFor}.ts`,
`packages/types/src/fieldProvenance.ts`, `packages/core/src/prospect/fieldProvenance.ts`,
`packages/core/src/webhooks/ssrfGuard.ts`, `packages/core/src/import/runImport.ts`. Design:
data-management `01`/`03`/`04`/`05`; `06-enrichment-engine.md`; `prospect-company-data` PLAN_06 /
BRAINSTORM_03; ADR-0021/0015/0025/0013/0003.
