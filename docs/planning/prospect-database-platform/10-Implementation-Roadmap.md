# 10 — Implementation Roadmap

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 10 · **Status:** ✅ Drafted
> · **Prev:** [`09-Security-Compliance-Scalability`](./09-Security-Compliance-Scalability.md)

---

## 1. Executive Summary

The dependency-ordered, gated build plan that turns Phases 03–09 into shippable increments. It honors three
rules: **(1)** the evidence log (P01) is the foundation everything else needs, so it goes first; **(2)** every
increment dual-writes / flags so the shipped request-time path never regresses; **(3)** destructive, cross-tenant,
and cred-gated work waits for sign-off (Security has final say; CI gates each slice).

## 2. Build sequence (stages, each gated)

| Stage | Builds | Gap(s) | Entry gate | Exit gate |
|---|---|---|---|---|
| **I0 — Evidence substrate** | `source_records` + `match_links` writers on the deterministic path (flagged dual-write); `ingestion_jobs`; `runImport` as the first connector | P01, P05(start) | planning reviewed | dual-write parity itest green; deterministic landing byte-identical |
| **I1 — Knowledge DB** | `projection_outbox` + survivorship projector; activate `field_provenance`/`prov_hwm`/score; freshness TTL + refresh scheduler; reuse-before-enrich | P03, P04(start), P10 | I0 green | merge→unmerge re-derive byte-identical; reuse skips a call when fresh |
| **I2 — Unified ingestion** | the ingestion contract + connector port/registry; `POST /ingest`; content-hash dedup | P05, P06 | I0 | idempotent re-delivery returns first; isolation itest |
| **I3 — Enrichment v2** | bulk producer + worker; worst-case spend gate + `awaiting_confirmation`; provider waterfall + history; console run/test-batch | P08, P09, A3 | I1 (reuse) | bulk drains queue; estimate ≥ spend; charge-on-hit-only |
| **I4 — DB-Ops module** | review queue + decisions; **dedup merge/split executor** (non-destructive); record detail (lineage/version/correct); advanced filters; batch admin | P11, P12, A2 | I1 + approvals (shipped) | merge→split→re-derive; maker≠checker; isolation |
| **I5 — Probabilistic ER** | Splink-style matcher → `match_links(review_status='pending')`; clerical retune loop | P02, A10 | I4 (queue) | no auto-merge above threshold without a human; FP/FN on a labeled set |
| **I6 — Chrome Extension** | the `chrome_extension` connector (server) → the extension app; consent/ToS gate | P07 | I2 + legal sign-off | idempotent re-capture; suppression blocks surfacing; consent rejection |
| **I7 — Scale & GA** | bulk-import GA (COPY spike + S3); commercial verifier; residency/dedicated-cluster routing; SLOs/alerting | P13, P14, scale | infra/creds | canary clean; SLOs published |

Parallelizable: I2 ∥ I3 after I1; I6 after I2; I7 is infra-gated throughout.

## 3. Migration strategy (the load-bearing risk)

- **Dual-write everything new** (evidence, match_links, projection) behind `INGESTION_EVIDENCE_ENABLED` /
  `KNOWLEDGE_DB_ENABLED`; the shipped deterministic landing stays authoritative until parity is itest-proven, then
  the projector flips to authoritative per data class (canary first).
- **Backfill** `source_records` from existing `contacts`/imports as "legacy evidence" so the projector has a
  baseline; backfill is idempotent + resumable.
- **Migration numbering:** sequential at PR time (the repo's rule); the sandbox can't run `drizzle-kit generate`,
  so new tables ship via the `rls/*.sql` defensive-CREATE pattern + a CI regen flag (as the shipped validation/
  approval tables did).

## 4. Rollback strategy

Every stage is flag-gated and additive: flag off → the prior behavior (today's request-time path) returns with no
orphaned writes. Evidence/outbox rows are safe to leave. Merges are non-destructive (re-derivable). Retention
enforce + destructive deletes are separately sign-off-gated and tombstone-reversible.

## 5. Risk register

| Risk | Sev | Mitigation |
|---|---|---|
| Evidence migration regresses imports | S0 | dual-write + byte-identical parity itest before flip |
| Cross-tenant PII leak (owner path) | S0 | explicit-scope suppression rule + isolation itests + security review |
| Runaway enrichment spend | S1 | reuse + waterfall gating + worst-case pre-compute + breakers |
| Extension ToS/consent exposure | S1 | consent recording + authorized-view-only + legal sign-off |
| Projector lag at scale | S1 | async outbox + back-pressure + SLOs |
| Probabilistic Frankenstein merges | S1 | false-negative bias + steward review + labeled FP/FN gate |

## 6. Gates that are the user's (not the agent's)

- **CI** (`bun typecheck` / `biome` / `drizzle-kit generate` / itests) on every slice — the sandbox can't run them.
- **Security review** on each cross-tenant/PII path before `main`.
- **Creds/infra:** prod S3 (bulk + export delivery), Reacher/commercial verifier, residency clusters.
- **Sign-offs:** retention `enforce` rollout; extension GA (legal); destructive batch ops.
- **`main` promotion** is the user's action (`! git push origin HEAD:main`).

## 7. Implementation Checklist (program-level)

- [x] Planning Phases 00–10 documented + internally consistent.
- [ ] **Review** the planning docs (the documentation-first gate) — then begin I0.
- [ ] I0 → I7 sequentially, each: build safe slices → flag/gate the sensitive → commit + push the feature branch →
  CI + (where needed) security review → next.
