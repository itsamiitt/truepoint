# 00 — Data-Management Plan: Overview & Locked Decisions

> **Status:** Plan (design gate). **Last updated:** 2026-06-27. This is the **spine** for the
> `docs/planning/data-management/` series. The **Locked Decisions (§3)**, **Shared Vocabulary (§4)**,
> and **dimension→doc map (§5)** are canonical — every dimension doc (`02`–`07`) cites them verbatim
> and must not contradict them. **Converts** the research gate `01-research-brief.md` into a design
> set. **Posture:** reuse-and-extend (§2). **No source code, schema, SQL, or settings are modified by
> this gate — only docs.** House style: `list-plan/00-overview.md`. Brand **TruePoint**; code scope
> **`@leadwolf/*`** (both correct by design).

---

## 1. Why this series exists

The research gate (`01-research-brief.md`) established a single source of truth for how data
management works in TruePoint, pinned the canonical primitives to their one shipped implementation,
and corrected three stale external-audit premises. This series turns that research into **per-
dimension design** across the six dimensions the brief scoped: **identity & dedup, enrichment &
verification, provenance, compliance, storage & scale, sync**.

The purpose the whole series serves is the brief's purpose: **prevent the failure mode where multiple
normalizers, dedup paths, and import pipelines diverge** — by designing each dimension against the
one canonical primitive set, not around it.

## 2. Posture — reuse-and-extend (the defining constraint)

TruePoint already has a deep design corpus for the data layer: the 26-doc
`docs/planning/prospect-company-data/` set (RESEARCH→BRAINSTORM→PLAN, "design corpus complete"), the
`list-plan/` series, the numbered planning docs (`03`, `06`, `08`, `18`, `26`, `22`), and the ADRs.
Much of each dimension is **already designed or shipped.**

Therefore every dimension doc is written **reuse-and-extend**:

- **Reuse map** — cite the existing doc/code that already designs or builds this dimension. Do **not**
  re-derive it.
- **Net-new** — design only what is genuinely missing, plus the reconciliations the research flagged.

This is a deliberate divergence from the research brief's "full standalone" format (which re-derived
findings in one self-contained doc); the design sweep instead **leans on** the corpus to avoid
shipping redundant or drifting design. Where the design sweep and an existing doc disagree, the
tension is **flagged** in §coherence, never silently resolved.

## 3. Locked decisions (canonical — cite these everywhere)

> Derived from `01-research-brief.md`, ADR-0021/0015/0037/0006, and `prospect-company-data/PLAN_00`
> C1–C10. Not open for re-litigation inside a dimension doc.

- **DM1 — One canonical primitive set; never a second implementation.** The normalizers, identity
  ladder, confidence routing, provenance descriptor, and scoping predicate defined in
  `01-research-brief.md §3` are the **source of record**. A parallel normalizer is forbidden
  (ADR-0037 C5 / `prospect-company-data/PLAN_00` C5). Every dimension builds on them.
- **DM2 — Reuse-and-extend (§2).** Cite the existing corpus for settled design; design only net-new.
- **DM3 — The refuted premises stay refuted.** `A3` (triplicated normalizers), `A6` (country-code
  domain false merges), and SSRF-in-enrichment are **refuted with `file:line`** in
  `01-research-brief.md §6`. No dimension re-tasks "consolidate the normalizers" or "fix the
  country-code list." The **real** residuals (webhook DNS-rebind TOCTOU, mint-then-merge tail,
  IDOR-on-bypass, no verifier, no TCPA/DNC gating, Art.14/DPDP notice) are the work.
- **DM4 — Tenancy is unchanged.** Two-tier `tenant_id`/`workspace_id`; Layer-1 overlay is
  `ENABLE`+`FORCE` RLS on the fail-closed workspace GUC; Layer-0 master graph has **no RLS** —
  isolation by access path (grant-off). Within-workspace owner-scope is an **app-layer soft filter**
  (C10), never RLS (ADR-0021/0006/0022; `01 §3.5`).
- **DM5 — Identity is the deterministic ladder → Splink tail.** email blind index → LinkedIn public
  id → E.164 → registrable domain → fuzzy name+company; deterministic = 1.0; the fuzzy tail routes
  through **calibrated two-thresholds owned by `22 §5-6`**. MVP is deterministic-only; the
  mint-then-merge re-point cascade (C4) is designed day-one (ADR-0015/0021/0037).
- **DM6 — Provenance is one JSONB winner-map.** `field_provenance` per row (scalar slice now);
  channel (email/phone) provenance via `revealed_channels` (Phase 4); lawful basis at Layer 0
  (`source_records.lawful_basis_snapshot`). `pin=true` blocks overwrite (`prospect-company-data`
  PLAN_03; `01 §3.4`).
- **DM7 — Suppression is unbypassable; DSAR is golden-identity-anchored.** The in-tx tri-scoped
  suppression gate and the DSAR fan-out (`08-compliance.md`) are reused unchanged; compliance design
  **adds** Art.14 source-notice, India DPDP, and TCPA/DNC pre-dial scrubbing.
- **DM8 — Verification is required and hybrid.** A real `EmailVerifierPort` replaces the pass-through;
  the strategy is **Reacher (honest domains) + a commercial verifier (catch-all/Gmail/Yahoo)**;
  charge-for-verified is preserved (`01 §5.2`, `chargeFor.ts`).
- **DM9 — CRM sync is field-level source-of-truth + dedup-on-write.** Per-field master system + LWW
  tiebreak + review queue; dedup-on-write via the deterministic match keys; per-field direction;
  never overwrite human-edited fields (`field_provenance.pin`). **CRDT is rejected** for CRM field
  sync (`01 §5.5`).

## 4. Shared vocabulary (canonical)

Inherits `prospect-company-data/PLAN_00 §3` verbatim (Layer 0 / Layer 1 / overlay / master entity /
golden record / employment edge / **MATCH-AGAINST** vs **CONTRIBUTE-TO** / mint-then-merge /
provenance seam / projection boundary / scale track). New terms this series adds:

- **Canonical primitive** — a function/predicate defined once in `01 §3` and reused everywhere (DM1).
- **Verifier port** — the provider-independent `EmailVerifierPort` (+ a phone line-type port) that
  grades a channel so no data provider grades its own answer.
- **Source-notice** — the GDPR Art.14 / DPDP record-level duty to tell a data subject the **source**
  of their data, on a timing trigger (≤1 month / first contact / first disclosure).
- **Line-type gating** — pre-dial classification (mobile vs landline vs VoIP) that selects the TCPA
  consent level and feeds DNC scrubbing.
- **Field-level source-of-truth** — per-field declaration of which system wins on a sync conflict.
- **Dedup-on-write** — upsert on a stable match key so a sync never creates a duplicate downstream.

## 5. Dimension → doc map

| Doc | Dimension | Posture | Largest net-new |
|---|---|---|---|
| `01-research-brief.md` | Cross-cutting research (the gate) | done | — |
| `02-identity-and-dedup.md` | Identity & dedup | mostly reuse | URN↔slug reconciliation |
| `03-enrichment-and-verification.md` | Enrichment + verification | reuse waterfall | **verification subsystem** |
| `04-provenance.md` | Field & channel provenance | mostly reuse | channel provenance + lawful-basis link |
| `05-compliance.md` | Compliance | reuse suppression/DSAR | **Art.14 + DPDP + TCPA/DNC** |
| `06-storage-and-scale.md` | Storage & scale | mostly reuse | consolidated index strategy + scale-gate |
| `07-sync.md` | Bi-directional CRM sync | largely net-new | **conflict resolution** |

Every dimension doc carries: **Reuse map → Net-new → Target schema → RLS/scoping → Scale-gate →
Failure modes → Open questions** (the `prospect-company-data/PLAN_00 §8` required-section set).

## 6. Phase / dependency order

```
  01 research (done)
       │
       ▼
  00 spine (this) ── locks DM1–DM9 + vocabulary
       │
       ├──► 02 identity  ─┐ (the match keys + ladder the rest reuse)
       ├──► 04 provenance ┴─► both foundational; 03/05/07 consume them
       │
       ├──► 03 enrichment+verification   (needs identity keys + provenance pin)
       ├──► 05 compliance                (needs provenance lawful-basis + suppression)
       ├──► 07 sync                      (needs match keys + provenance pin)
       │
       └──► 06 storage & scale           (cross-cutting; scale-gates 03/05/07)
```

Build order for implementation is owned by each dimension's own rollout section and the existing
milestones (`10-roadmap.md`); this series is **design**, not the build schedule.

## 7. Success metrics (per dimension)

- **Identity:** ER precision ≥0.95 / false-merge ≤0.5% (calibrated, `22 §5-6`); zero bulk-vs-batch
  normalizer drift (one module).
- **Verification:** % channels graded by a real verifier; bounce rate on "valid" < target;
  catch-all correctly routed to "risky," never billed as valid.
- **Provenance:** every golden/overlay field answers "source, confidence, observed/verified when";
  human-pinned fields never overwritten.
- **Compliance:** 100% of reveals/sends suppression-gated; DSAR deletion provably cascades; Art.14/
  DPDP source-notice emitted on the timing trigger; pre-dial DNC + line-type checks run before any
  dial.
- **Storage/scale:** owner+tenant queries index-covered; search p95 within `18 §2` SLOs; the new
  dimensions (verifier, sync) carry a scale-gate.
- **Sync:** zero duplicates created in the customer CRM (dedup-on-write); zero human-edited fields
  overwritten by sync; conflicts resolved by field-level source-of-truth, not blind LWW.

## 8. Coherence note (self-review across the set)

> Filled by the final coherence pass after `02`–`07` are written (mirrors
> `prospect-company-data/00_INDEX §4`). Asserts: one schema spine, the scoping predicate identical
> everywhere, the canonical primitives cited (not re-defined), and no contradiction with ADR-0021/
> 0015/0037 or `prospect-company-data` C1–C10. Residual tensions are recorded as honest follow-ups,
> not silently resolved.

**Verdict (2026-06-27): coherent.** All six dimension docs cite DM1–DM9 + the `01 §3` primitives
rather than re-defining them; the scoping predicate (`workspace_id = NULLIF(current_setting(
'app.current_workspace_id', true), '')::uuid`, FORCE-RLS overlay; Layer-0 by access path) is stated
identically in `02 §RLS`–`07 §RLS`; the deterministic ladder + calibrated thresholds, the
`field_provenance` winner-map, and the suppression/DSAR machinery are reused unchanged. Recorded
follow-ups (not blockers): (a) **URN↔slug** — `02` proposes capturing the LinkedIn URN as an
*additional* deterministic key without displacing the shipped slug key; ratify in a future ADR if
adopted. (b) **Verifier vendor** — `03` locks the *hybrid shape*; the specific commercial vendor is
an open question owned by ops. (c) **`revealed_channels`** (channel provenance) is referenced by
`04` and `03` but built in Phase 4 — the seam is reserved, the build deferred. (d) **CRM sync** (`07`)
is the least-supported-by-shipped-code dimension; it reuses primitives but its tables are greenfield.
