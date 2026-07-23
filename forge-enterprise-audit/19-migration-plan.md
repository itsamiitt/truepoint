# 19 — Migration Plan

> **Priority:** P1 · **Effort:** folded into F1–F3 (this document is the *how* of safe change) ·
> **Phase:** spans all · Cite problems as **P-01.x**.

## Executive summary

This document is the migration discipline for turning the Forge scaffold into the enterprise platform
without breaking the running system or corrupting the master graph. The good news repeats: **Forge has
no production data and its capture/sync flags are dark**, so the F1 correctness and security work
carries near-zero migration risk — it changes code and schema on a pipeline nothing depends on yet. The
migration *risk* concentrates in exactly two places: (1) the **duplication convergence** (unifying the
blind index and content hash), because those keys are shared with the live main-app master graph, and a
careless cutover silently corrupts identity; and (2) the **data-model evolutions in F2** (provenance,
the object-storage raw archive, the identity graph), which touch tables that will by then hold canary
data. Both are handled with the same pattern the main app already uses for its channel migration:
**additive schema → dual-write behind a dual-gate → backfill → prove parity → cut reads over → delete
the old path.** Everything else — new tables, new queues, new services — is purely additive.

Two hard constraints from the repository shape every migration here: **all migrations are hand-authored
(`drizzle-kit generate` is unsafe, re-adds dropped tables)**, and the coordinator host has no Docker, so
new-table features are CI-verified rather than locally applied (fact-pack §2.3). The plan respects both.

## Current state

- The `forge` schema is one hand-authored migration (`0070_forge_schema.sql`), applied by the single
  `migrate` service alongside everything else (`packages/db/src/applyMigrations.ts`); there is no
  separate forge migration runner.
- The main app already ships the migration pattern this plan reuses: the channel dual-gate
  (`CHANNEL_DUAL_WRITE`/`CHANNEL_READ_FROM_CHILD`), the transactional outbox (ADR-0027), backfill +
  reconcile sweeps, and the import COPY-staging trio (ADR-0036) (fact-pack §2.3).
- Two migrations already share journal index 0053 (a renumbering artifact) and a schema comment points
  at a non-existent "migration 0054" — the numbering hygiene must be fixed as part of the first forge
  migration wave (P-01.30).

## Problems identified

- **P-19.1 — RISK · The identity-key cutover is the one migration that can corrupt live data.**
  Unifying the blind index/content hash touches keys the live master graph depends on; a read cutover
  before parity is proven silently mismatches identities (R-04, `18-risk-analysis.md`).
- **P-19.2 — RISK · No forge migration tests today** (P-01.28) means migrations 0070 + grants have
  never been asserted under CI Postgres; the plan's parity/isolation tests must land before any cutover.
- **P-19.3 — DEBT · Migration numbering hygiene** (duplicate 0053, stale 0054 comment) must be corrected
  so the hand-authored ordering stays legible.

## Research findings

The dual-write-then-cutover-then-delete pattern with a reconciliation sweep is the standard for
zero-downtime schema and store migrations, and dual-writing from application code is explicitly the
*wrong* way to keep two stores in sync at steady state (race conditions, partial failures) — the correct
steady state is one source of truth with derived projections
([Streamkap CDC](https://streamkap.com/resources-and-guides/postgresql-to-elasticsearch-cdc),
[AWS transactional outbox](https://docs.aws.amazon.com/prescriptive-guidance/latest/cloud-design-patterns/transactional-outbox.html)).
Dual-write is acceptable *only* as a transient migration state, gated and reconciled, then removed — which
is exactly how this plan scopes it.

## Recommended migration approach

### The reusable pattern (every risky change follows this)

```text
1. ADD        additive schema/columns/tables; new code paths dark behind a flag
2. DUAL-WRITE write both old and new representations behind a WRITE gate
3. BACKFILL   batched, idempotent job fills the new representation from the old
4. RECONCILE  a sweep repairs drift; a parity test asserts old ≡ new
5. CUT READS  flip a READ gate to the new representation (old still written)
6. SOAK       run on the new read path; watch metrics; keep rollback trivial
7. DELETE     once soaked, stop dual-writing and delete the old representation
```

Rollback is trivial at every step before 7: flip the read gate back. Only step 7 is irreversible, and it
happens only after a soak.

### Phase-by-phase migration

**F1 — no live data, low migration risk.** Capture/sync are dark, so most F1 changes are ordinary code +
additive schema:
- New tables (`extraction_candidates`, persisted DLQ/quarantine, `capture_claims`, `pipeline_outbox`)
  are additive hand-authored migrations; fix the 0053/0054 numbering as the first wave (P-19.3).
- The parser-registry fix (P-01.1) either persists `parser_versions` (additive) or changes the FK to a
  text natural key (a hand-authored migration with an up/down); either way, nothing depends on the empty
  table today.
- **The identity-key convergence (the one risky F1 item)** runs the full dual-gate pattern *against the
  main app's live master graph*: introduce `@leadwolf/identity` with the unified HMAC/encoding/normalize;
  dual-write both the old and new blind index/content hash; backfill the main-app tables; **prove parity
  with an identity-match test** (a Forge-computed index for a known email equals the main-app-computed
  one); only then cut master-graph reads to the unified value; soak; delete the forge hex variant. This
  is the one F1 change that touches production data, so it gets the most ceremony.

**F2 — canary data, additive-then-backfill.** By F2, canary/synthetic tenants exist:
- **Provenance model:** add per-field `(source_type, source_detail, captured_at, lawful_basis,
  contract_version)` columns/tables (additive); backfill from existing source attribution; reads adopt
  provenance behind a flag.
- **Raw archive to R2:** dual-write raw payloads to Postgres *and* R2 behind a gate; backfill existing
  rows to R2; verify content-addressed integrity; cut the parse blob-fetch to read from R2; soak; stop
  writing `payload_inline` (keep the column nullable as the primary-value cache pattern the main app
  uses for channels). Encrypt on the R2 write (SSE-KMS) from the start.
- **Identity graph + one ER engine:** the graph tables (`entities`, `entity_members`, `match_edges`,
  `entity_events`, `golden_versions`) are additive; the resolve stage is wired to run `@leadwolf/identity`
  ER in *shadow* first (compute clusters, write `match_edges`, do not merge), compared against expected
  results, then promoted to live merging. The inert main-app `er/` is deleted only after the Forge engine
  is live (ADR-0047), following the same shadow-then-promote discipline `ER_SHADOW_ENABLED` already
  implies.
- **DSAR/suppression:** the subject blind-index index and the DSAR executor are additive; a DSAR test
  proves erasure reaches bronze→silver→gold→master→search before the executor is trusted.
- **ClickHouse:** stood up as a new service; fed by dual-write first, then PeerDB/outbox CDC — no
  migration of authoritative data, only a derived projection.

**F3 — GA behind a per-tenant canary.** Capture/sync graduate from dark to a per-tenant canary using the
planning suite's metric-driven canary logic (`ga.ts`, once persisted): enable capture for one internal/
friendly tenant, watch the DATA-plane monitors and error/freshness SLOs (`12-observability.md`), and
auto-rollback (flag off) on breach. Partitioning (`pg_partman`) and the ParadeDB search index are
additive with alias-based zero-downtime reindex from a Postgres snapshot (`10-search-indexing.md`). The
compliance spine must be green for the canary tenant before its flag flips (`07`, `18` R-01/R-10).

### The extension cutover (retiring the `/ingest` stub, OQ-5)

The extension currently posts to the main `/api/v1/ingest` stub and loses data (P-01.5). The cutover:
1. Ship the real `@leadwolf/forge-capture-sdk` and forge-api `/v1/captures` write path (F1).
2. Dual-target: the extension posts to *both* the old stub and the new Forge edge behind a client flag,
   or (simpler) point the extension at Forge and keep the stub returning 202 for old client versions.
3. Verify Forge landing (bronze rows appear for the canary tenant).
4. Retire the `chrome_extension` connector on `/ingest` and remove the client-side "delete on 202/400"
   behavior that caused the loss.
This is the one migration that changes a shipped client, so it respects the extension's release cadence
and the Chrome Web Store review timeline.

## Implementation details

- Hand-authored migrations only, in `packages/db/src/migrations/`, each with an explicit up (and a down
  where reversible); no `drizzle-kit generate`. Fix the 0053 duplicate and the stale 0054 comment in the
  first F1 wave.
- Dual-gates as env flags in the validated config (once forge config moves there, P-01.29):
  `FORGE_IDENTITY_UNIFY_WRITE`/`_READ`, `FORGE_RAW_ARCHIVE_WRITE`/`_READ`, `FORGE_ER_SHADOW`/`_LIVE`.
- Backfill/reconcile runners as leader-locked worker sweeps (reuse the main app's sweep pattern), batched
  and idempotent (`08-pipeline-architecture.md`).
- Parity/identity-match/DSAR/isolation tests in `packages/db/test/` and `apps/forge-*/test/`, wired into
  CI (P-19.2) and required to pass before any read cutover.

## Migration strategy (rollback)

Every step before the final delete is a flag flip away from the prior state. The dark capture/sync flags
are the outermost rollback for the whole platform: if anything in F1/F2 misbehaves, capture stays off and
no production data is affected. For the identity-key cutover specifically, the read gate is the rollback,
and the old representation is retained until a full soak passes — a wrong cut is recoverable by flipping
the gate, not by a restore.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Identity-key read cutover before parity proven (P-19.1) | Medium | High | Identity-match test gates the read flip; retain old value through soak |
| A hand-authored migration ordering error (P-19.3) | Medium | Medium | Fix numbering first; CI applies migrations against real Postgres |
| Backfill runs unbounded and locks tables | Medium | Medium | Batched, idempotent, leader-locked sweeps; watch queue depth |
| Extension cutover loses data during transition | Low | High | Verify bronze landing before retiring the stub; dual-target briefly |
| R2 archive integrity gap during dual-write | Low | High | Content-addressed verification before cutting the read path |

## Success metrics

- The identity-key convergence completes with a green identity-match test and zero master-graph mismatch.
- Raw payloads migrate to R2 with 100% content-addressed integrity; `payload_inline` reads cease.
- The ER engine runs in shadow with cluster parity before live merging; the main `er/` is deleted only
  after.
- A DSAR erases a subject across all stores in a test before the executor is trusted.
- Every risky migration has a working read-gate rollback demonstrated in staging.

## Effort & priority

**P1.** The migration work is not separate effort — it is *how* the F1–F3 changes land safely, folded
into each workstream. The one place that warrants dedicated ceremony is the identity-key convergence
(~1 week of migration + parity work inside the F1 identity task), because it is the only change that can
silently corrupt live data.

## Future enhancements

A standing migration playbook and a "risky-migration checklist" (additive-first, dual-gate, parity test,
soak, delete) adopted repo-wide; automated drift-detection between Forge's golden records and the master
graph (the reconciliation sweep from `08`) as a permanent safety net beyond the migration itself.
