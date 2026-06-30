# 16 — Implementation Audit (Gap Register)

> **Series:** [Database Management](./README.md) · **Type:** Audit · **Status:** 🔶 Living
> · **Prev:** [`15-Future-Enhancements`](./15-Future-Enhancements.md)
> · **Roadmap:** [`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md)

---

## 1. Objective

Audit the **shipped** Database-Management implementation on branch
`feat/data-mgmt-01-research-brief` against the roadmap ([`14`](./14-Implementation-Roadmap.md),
gaps G01–G32) and the user's answered build decisions, and record every remaining gap with a
**status** and a **next step**. Produced by reading the code paths (no `bun`/`biome`/`typecheck`
available in this environment — verification is by reading + pending CI).

**Decision rule for this audit:** a gap is only marked *fixable-now* if it can be built **safely
without gates**. Anything that, built blind, risks a **PII leak, data corruption, uncontrolled
spend, or a destructive delete** is marked **NEEDS-REVIEW** (build behind CI + security sign-off),
**CRED-GATED**, or **DEFERRED** — *not* guessed at. This follows `14 §6` (Security has final say)
and the user's "CI and PR last" directive.

---

## 2. What's DONE (built this cycle — 8 commits, pushed, not yet CI-gated)

| Gap | Deliverable | Commit(s) |
|---|---|---|
| **G02** | `data:read` capability + gate | (earlier) |
| **G01** | Admin **Data management** nav + **Data-Ops Overview** | (earlier) |
| **G03** | Import **drill-down** (counts/metadata, no row PII) | (earlier) |
| **G18** | **Fleet data-quality** cross-tenant view | (earlier) |
| **G13** | `data:manage` + `data:review` caps + **`data_ops` staff role** | `7da2705` |
| **G14** | **Maker-checker approval** engine + **retention-enforce producer/executor** (the first real workflow; direct enforce flip now blocked → must go through approval) | `f66a368` |
| **G07** | **Validation framework end-to-end**: rules table + RLS + pure engine; CRUD backend; rule-builder UI; canonical-field picker; **import-pipeline enforcement** (custom rules, reject-on-fail, fail-open, non-breaking) | `b739e54` `4e5d61b` `c5922e1` `abef8ce` `a450195` |
| **G10 (read)** | **Dedup / ER clerical-review READ surface** (`data:review`, PII-gated, owner-path master-graph read) | `59dc00c` |

**Capabilities present:** `data:read` / `data:manage` / `data:review` / `data:export` (the export
cap exists; the export *path* does not — see G15). **Approval operations enum:** `bulk_delete`,
`dedup_merge`, `retention_enforce`, `bulk_export` (only `retention_enforce` has a wired executor).

---

## 3. Gap Register — remaining work

Severity: **S0** = blocks safe use / correctness · **S1** = significant feature · **S2** = polish.
Status: **NEEDS-REVIEW** (buildable but unsafe blind) · **CRED-GATED** · **NEEDS-DATA** ·
**DEFERRED** (large/enterprise or policy) · **DONE-PARTIAL**.

| ID | Area | Sev | Status | Finding / why not blind-built | Next step |
|---|---|---|---|---|---|
| **A1 / G15 G23 G32** | **Export** (CSV + suppression + approval) | S1 | **NEEDS-REVIEW + CRED-GATED** | Exporting contacts = **revealing/decrypting PII**, coupled to the metered, audited **reveal path** + its `assertNotSuppressed` gate. A naive `contacts→CSV` SELECT bypasses suppression/metering → **PII-leak risk**. Delivery also needs **S3** (signed URL); `bulk_export` approval op exists but has no executor. | Build the executor **through the reveal path** (not a raw SELECT), so suppression + audit + metering are enforced by the existing gate; inject the prod **S3** FileStore; **security review** of the suppression filter + the cross-tenant PII egress before merge. |
| **A2 / G10 (actions)** | **Dedup merge / split** | S1 | **NEEDS-REVIEW** | The actions mutate the **system-owned master graph** (`withErTx`, `match_links` / `master_*`). Q12 = non-destructive + re-derivable. A blind survivorship/re-point error **corrupts the golden graph**. | Build the **producer** (file a `dedup_merge` approval from the review queue) first; build the executor **non-destructively** (tombstone + re-point, re-derivable) behind maker-checker; **security review** before merge. |
| **A3 / G11** | **Enrichment console writes** (re-run / test-batch) | S1 | **NEEDS-REVIEW** | Re-run triggers **metered cross-tenant enrichment spend**. No `bulk_enrich` approval op; no worst-case-spend pre-compute (the `14`/G14 requirement). A blind re-enqueue risks **uncontrolled spend**. | Add a `bulk_enrich` approval op; gate full re-runs behind maker-checker; allow only a **bounded test-batch** (25–50 rows) directly (matches the "skip approval for tiny jobs" decision); locate the enrichment enqueue path first. |
| **A4 / G08** | **Reject-triage staff histogram** | S2 | **DEFERRED (PII)** | The code **already defers** this: `platformAdminReads.ts:575` — *"reject-reason histogram deferred until reject_reason is confirmed a non-PII code."* Current validation reasons ARE generic codes, but the runImport catch-path can surface a raw DB-error string. | Either (a) confirm/normalize `reject_reason` to a **closed non-PII code set** then build the staff histogram, or (b) ship reject inspection **customer-side only** (own data) under G19. |
| **A5 / G19** | **Customer self-service** (`apps/web`) | S1 | **NOT-BUILT (large)** | Own-workspace import / dedup-view / export / DSAR; `withTenantTx` + `requireOrgRole`. Large; depends on the export (A1) + dedup decisions. Safe (own-data) but sizeable. | Build after A1/A2 land; it's the natural home for customer-side reject inspection (A4b) + own-data export. |
| **A6 / G17 G31** | **Monitoring dashboards + quality sub-scores** | S2 | **NEEDS-DATA** | G17 wants segment match-rate / FP-FN vs a **labeled set** / per-tier verification yield — instrumentation **not yet captured**. G31's six per-dimension sub-scores need the dimensions present on `data_quality_snapshots` (to verify). | Build the sub-scores **only over dimensions that exist**; instrument the missing signals first; do not synthesize a labeled set. |
| **A7 / G04 G05 G06** | **Bulk import enable** | S1 | **CRED-GATED + INFRA** | COPY-FROM-STDIN spike + prod **S3** object store + per-tenant flag flip. Pipeline built, **DARK**. | Needs the COPY spike sign-off + S3; then canary-flip `bulk_import_enabled`. |
| **A8 / G12** | **Commercial email verifier** | S2 | **CRED-GATED** | User chose **Reacher**; pass-through until `REACHER_*` creds wired. | Drop Reacher backend URL/token → the shipped `hybridVerifier` leg lights up. |
| **A9 / G20** | **Retention `enforce` rollout** | S0 | **DEFERRED (sign-off)** | The approval **mechanism** is built (`f66a368`); the **graduated destructive rollout** (shadow→enforce per class on a canary) deletes real data. | **Explicit sign-off required** before any class flips to `enforce`; tombstone-reversible; canary first. |
| **A10 / G27** | **Probabilistic ER (Splink)** | S1 | **DEFERRED (XL)** | The user chose "advanced fuzzy matching", but it's a multi-week distributed-engine build; it's also what **populates the dedup `pending` queue** (so the A2 review queue is sparse until it lands). | Enterprise/scale track; build after the review actions (A2) exist to consume it. |
| **A11 / G21 G22 G24 G25 G26 G28 G29 G30** | **Enterprise: version-history, SLOs, survivorship, bulk-lane, blocking, CRM-sync, residency, rules-engine** | — | **DEFERRED (enterprise)** | Multi-quarter, mostly enterprise-deal-driven (`14 §3.4`). | Sequence per signed requirement. |

---

## 4. Cross-cutting must-fix (independent of the gaps above)

| ID | Item | Sev | Status |
|---|---|---|---|
| **X1** | **CI not run** — 8 commits add a new table, RLS, a core engine change (`runImport`), API + UI, all **un-gated** (no `typecheck`/`biome`/itests here). | S0 | **Pending the user's CI.** Paste anything red; fixes batched. |
| **X2** | **Drizzle migration regen** — `validation_rules` (+ earlier `approval_requests`) ship via the `rls/*.sql` **defensive-CREATE** (runtime-safe), but the canonical Drizzle migration + snapshot must be generated. | S1 | **`drizzle-kit generate` in CI** (sandbox lacks it). |
| **X3** | **Security review** — the cross-tenant **PII reads** (dedup names) + the future **export suppression** (A1) + **dedup-merge** (A2) need an isolation/PII sign-off. Security has final say (`14 §6`). | S0 | **Blocks A1/A2 to `main`.** |
| **X4** | **`main` promotion** — branch is 8 commits ahead; promotion is a clean fast-forward but is the **user's** action (`! git push origin HEAD:main`); the harness blocks the agent. | — | User action. |

---

## 5. Recommended sequence to finish

1. **Run CI** on the 8 pushed commits (X1) + `drizzle-kit generate` (X2); fix any red.
2. **Security review** (X3) of the dedup PII read + the export/dedup-merge designs in A1/A2.
3. Provide **S3** (A1/A7) and **Reacher** (A8) creds.
4. With CI green + review + creds: build **A1 export** (through the reveal path), **A2 dedup
   actions** (non-destructive), **A3 enrichment** (spend-gated), then **A5 self-service**.
5. **A9 retention enforce** only on explicit sign-off; **A10 Splink** + **A11 enterprise** per
   deal pull.

> **Status of this audit:** Phase-A *cleanly-buildable* gaps are committed. The remainder is
> **NEEDS-REVIEW / CRED-GATED / NEEDS-DATA / DEFERRED** as above — intentionally **not** blind-built,
> to avoid a PII leak, graph corruption, uncontrolled spend, or an unsanctioned delete.
