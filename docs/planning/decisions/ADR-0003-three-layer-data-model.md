# ADR-0003 — Three-layer data model: raw / provenance / golden

- **Status:** Superseded by [ADR-0006](./ADR-0006-per-workspace-multitenant-model.md) (2026-05-29)
- **Date:** 2026-05-29
- **Superseded note:** The 2026-05-29 repositioning to a per-workspace prospecting CRM replaced the global raw→provenance→golden model with per-workspace contact copies whose provenance is captured by `source_imports`. ADR-0006 documents the consciously-accepted losses (field-level provenance, replay/unmerge, cross-source dedup, provable DSAR-by-source). This body is retained as the record of what was traded away.
- **Context doc:** [03-database-design.md](../03-database-design.md), [08-compliance.md](../08-compliance.md)

## Context

LeadWolf assembles each person/company from **many sources** (CSV import, scrapers, multiple enrichment
providers). We must:

- present one clean **golden record** to the product,
- explain **where every field came from** (source, confidence, when) — for trust, debugging, and DSAR,
- delete a subject's data **completely and verifiably** (GDPR/CCPA),
- and **re-merge** when our matching algorithm improves, without losing original truth.

A single mutable row per entity cannot satisfy these — it destroys history and provenance on every
update.

## Decision

Model data in **three layers**:

1. **`raw_records`** — immutable, append-only verbatim observations (one per source-parse / row /
   provider response), with `content_hash`, source, fetch time, lawful-basis snapshot.
2. **`field_provenance`** — per-**field** lineage: which `raw_record`/source set the current value of a
   golden field, at what confidence, when. Exactly one `is_current` row per `(entity, field)` (partial
   unique index); superseded rows retained.
3. **`persons` / `companies`** — the canonical golden records the product reads. Each field value is
   the current `argmax(confidence) → trust → recency` winner; PII encrypted, masked until reveal.

## Rationale / consequences

- **Explainability:** any field answers "source X, confidence Y, observed Z" directly from provenance.
- **DSAR completeness:** because provenance + raw record *every* place a subject's data lives, deletion
  can purge golden + raw + caches and **verify** nothing remains. (See [08 §4.2](../08-compliance.md).)
- **Replay/unmerge:** immutable raw lets us recompute golden records if matching improves or a bad
  merge happens — the key safety net for the riskiest subsystem (identity resolution).
- **Conflict handling:** disagreeing sources coexist as provenance rows; we never silently overwrite.

**Costs:**
- More storage (raw kept verbatim) → mitigated by time-partitioning + S3 archival of old partitions.
- More write work per ingest (raw + provenance + golden update in a transaction) → acceptable; these
  are background/worker paths, not user-blocking.
- More schema complexity → contained in `packages/db` + `packages/identity` with clear repositories.

## Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Single mutable golden row | Rejected | No provenance, no replay, DSAR completeness unprovable. |
| Golden + raw, no per-field provenance | Rejected | Can't explain individual fields or merge by confidence. |
| Event-sourcing everything | Rejected (now) | Overkill; raw_records + ledger/audit already give the auditability we need. |

## Revisit if
Storage or write amplification becomes a real problem at scale — consider compacting very old raw
records to provenance-only, or moving raw fully to object storage with DB pointers.
