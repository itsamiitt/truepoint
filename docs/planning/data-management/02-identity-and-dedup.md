# 02 — Identity & Dedup (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM1/DM4/DM5 and `01-research-brief.md §3.1-§3.3`.
> **Posture: mostly reuse** — identity resolution is the most-designed dimension in the repo. This
> doc ratifies the canonical contract and designs the one reconciliation the research flagged
> (LinkedIn URN vs public-id slug). **No code changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| Canonical normalizers (email/domain/phone/name/LinkedIn), one module | `@leadwolf/core` `import/normalize.ts`, `enrichment/matchKeys.ts` (`01 §3.1`) |
| eTLD+1 registrable domain via Public Suffix List (`tldts`) | `enrichment/matchKeys.ts:74` |
| Freemail guard (prevents fake company nodes) | `enrichment/freemailDomains.ts:20-72` |
| Deterministic ladder (email→linkedin→phone→domain→fuzzy) | `enrichment/bulk/overlayMatcher.ts:20-25` |
| `MatchPort` seam + overlay matcher (real) / master-graph matcher (stub) | `enrichment/bulk/{matchPort,overlayMatcher,masterGraphMatcher}.ts`; ADR-0037 |
| Global ER: deterministic keys → blocking/MinHash-LSH → Splink → survivorship | ADR-0021 Decision; ADR-0015 |
| Within-file + overlay two-pass import dedup; per-attribute survivorship | ADR-0015 (import-path dedup); `prospect-company-data` PLAN_02 |
| Calibrated two-threshold routing + ER precision ≥0.95 / false-merge ≤0.5% | ADR-0015; **owned by `22 §5-6`** |
| Mint-then-merge + `match_links.is_duplicate_of` re-point cascade (C4) | `prospect-company-data` PLAN_00 C4; PLAN_02 |
| Master entity model (`master_persons/companies/employment/emails/phones`) | `prospect-company-data` PLAN_01/02; `03-database-design.md §5.1` |

**Conclusion:** identity & dedup is designed end-to-end. The `A3`/`A6` premises are **refuted**
(`01 §6`, DM3). The net-new is small.

## 2. Net-new (design here)

### 2.1 Ratify the canonical identity contract

State, as a binding contract for all later phases (DM1): the **only** identity normalizers/keys are
those in `matchKeys.ts` + `normalize.ts`; no dimension (verification, sync, import, search) may
introduce a parallel normalizer (ADR-0037 C5). The deterministic ladder order is fixed
(`overlayMatcher.ts:20-25`). Confidence is 1.0 for deterministic; the fuzzy threshold is injected and
**calibrated by `22 §5-6`**, never hardcoded.

### 2.2 LinkedIn URN ↔ public-id slug reconciliation (the one real reconciliation)

The research brief noted the brief's proposed hierarchy said "LinkedIn URN," but the code resolves on
the **public-id slug** (`linkedinPublicIdOf`, `normalize.ts:48`; key `deterministic_linkedin`). These
are different identifiers: the **slug** (`/in/<slug>`) is user-mutable (a person can change their
vanity URL); the **URN** (`urn:li:fsd_profile:<id>` / numeric member id) is stable but only available
on URN-rich captures (Sales Navigator, the API), not on raw CSVs.

**Decision (proposed, ratify in a future ADR):** keep the **slug as the shipped deterministic key**
(it covers CSV + URL captures), and **add the URN as an *additional, stronger* deterministic key
when present** — it slots **above** the slug in the ladder for URN-rich sources, and falls back to
the slug when absent. This is additive (a new optional `MatchKeys.linkedinUrn` + a
`deterministic_linkedin_urn` method above `deterministic_linkedin`); it does **not** displace or
re-implement the slug normalizer (DM1). Capture path: Sales-Navigator/API ingest populates the URN;
CSV ingest leaves it null and uses the slug. *Open question:* whether the URN is worth the added key
before the master-graph matcher is real (it is most valuable at global ER, currently a stub) — see §6.

### 2.3 Make the IDOR residual a standing assertion

Within-workspace reads are owner-soft-filtered at the app layer (C10), with client IDs re-filtered
through `contactRepository.visibleContactIds()` inside the RLS tx (`01 §3.5`). Net-new: a **standing
review rule** — every new bulk/mutation/identity path that accepts client-supplied record IDs **must**
route them through `visibleContactIds()` (or the equivalent RLS-scoped re-fetch) before use; a path
that trusts a raw client ID is the IDOR residual R6 and is a review blocker.

## 3. Target schema

No new tables. **Additive only**, gated on adoption of §2.2:

| Table | Add | Rule |
|---|---|---|
| (match keys, in-code) | `MatchKeys.linkedinUrn?: string` | optional; null for URN-poor sources |
| `master_persons` | `linkedin_urn` (nullable, UNIQUE) — *if* URN adopted | a second stable identity key alongside `linkedin_public_id` |

Everything else is the frozen `prospect-company-data` PLAN_01/02 schema (`master_*`, overlay
`master_*_id` nullable, the per-workspace dedup uniques on `contacts`). **Cite, do not re-freeze.**

## 4. RLS / scoping implications

Unchanged (DM4). Identity resolution runs under `withErTx` (`leadwolf_er`, non-BYPASSRLS, no overlay
grant — reaches only Layer-0 `master_*`) for the master-graph path, and within `withTenantTx` for the
overlay match. The overlay FORCE-RLS predicate is untouched; `master_*_id` is an opaque pointer the
overlay may store, never a Layer-0 read grant (`01 §3.5`; `prospect-company-data` C7/C8).

## 5. Scale-gate analysis (what breaks first at 10x)

| Breaks first | Why | Fix (deferred?) |
|---|---|---|
| Bulk MATCH-AGAINST candidate generation | O(n²) at billions without blocking | **Deferred — scale track:** blocking + MinHash/LSH + Splink-on-Spark (ADR-0021); MVP is deterministic index hits |
| Mint-then-merge duplicate population | deterministic-only mints dupes with no shared exact key | **In-scope design:** C4 re-point cascade (async, `is_duplicate_of`-driven); tolerated-rate is an ops open question |
| Adding the URN key at scale | another UNIQUE index on a billions-row table | additive partial index `WHERE linkedin_urn IS NOT NULL`; only if §2.2 adopted |

## 6. Failure modes

- **F1 — mint-then-merge corruption** (the A-killer): mitigated by C4 (mutable pointer + monitored
  async re-point sweep). Idempotency: `source_records.content_hash` UNIQUE + per-workspace blind-index
  uniques.
- **F2 — slug churn breaks identity:** a person changes their vanity URL → the slug key misses. The
  URN key (§2.2) mitigates for URN-rich sources; for slug-only sources, the email/domain keys carry
  the match.
- **F3 — second normalizer drift:** forbidden by DM1/ADR-0037 C5; enforced in review.

## 7. Open questions

1. **URN adoption (§2.2):** add the URN key now, or defer until the master-graph matcher is real
   (scale track)? Owner: data + `truepoint-operations` (the value is mostly at global ER).
2. **Tolerated pre-ER duplicate rate** (inherited from `prospect-company-data` PLAN_00 §11.2): the
   ratified `master_persons`/`master_companies` duplicate budget + its metric. Owner: ops.
3. Confidence-threshold calibration values remain owned by `22 §5-6` (not this doc).
