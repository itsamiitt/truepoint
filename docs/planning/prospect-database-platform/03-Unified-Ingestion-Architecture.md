# 03 — Unified Ingestion Architecture

> **Series:** [Prospect Database Platform](./README.md) · **Phase:** 03 · **Status:** ✅ Drafted
> · **Prev:** [`02-Current-State-Deep-Audit`](./02-Current-State-Deep-Audit.md) · **Next:** `04-Processing-Pipeline`

---

## 1. Executive Summary

Every prospect/company observation — from an admin upload, the Chrome extension, an enrichment provider, a CRM
sync, a web form, or a rep submission — enters through **one idempotent ingestion contract** and is recorded as an
**immutable evidence row** before identity resolution. Sources are **connectors** implementing a small port;
adding a source never touches the pipeline. This fixes gaps P05/P06 and is the front door to the evidence log
(P01).

## 2. Objectives

- One entry contract, many connectors; no per-source dedup/validate/enrich code.
- Idempotent, audited, suppression-aware, queue-backed, back-pressure-safe at high volume.
- Evidence-first: record *what was observed and by whom* before mutating any golden record.

## 3. Research synthesis (from Phase 01)

ZoomInfo/Apollo blend many collectors behind one pipeline and treat each observation as evidence + provenance;
capture (extension) is a queued source, processed server-side. We adopt the **unified-contract + connector +
evidence-row** pattern (advantages: extensibility, consistent dedup/suppression, lineage; disadvantage: an extra
write + a projector — accepted, it is the platform's foundation).

## 4. Proposed Architecture

### 4.1 The ingestion contract

```
IngestionEnvelope {
  source: ConnectorId            // admin_upload | chrome_extension | enrichment:<provider> | crm:<system> | web_form | rep_submission | api | marketplace
  scope:  { tenantId, workspaceId? }   // workspace-scoped overlay; platform sources may be tenant-less
  idempotencyKey: string         // dedupes re-delivery (reuses the import_jobs idempotency pattern)
  collectedAt: timestamp
  consent?:  ConsentContext      // required for extension/web-form (Phase 06/09)
  records: RawObservation[]      // mapped to canonical fields downstream, raw kept verbatim
}
```

- **Idempotency:** `(source, idempotencyKey)` unique — re-delivery returns the first result (the proven bulk/
  export pattern, audit G32). **Content-hash** per record dedupes identical re-observation (as `runImport` does).
- **Sync vs async:** small/interactive ingests (extension single-capture) ack fast then process on a queue;
  bulk ingests stage to the object store (the COPY pipeline) and fan out. Producer = `apps/api`; consumer =
  `apps/workers` (BullMQ), one **`ingestion`** queue + DLQ.

### 4.2 The connector port

```
interface Connector {
  id: ConnectorId
  validateEnvelope(env): Result            // shape + consent + auth
  toRawObservations(payload): RawObservation[]   // source-specific → the common raw shape
  // everything after this (validate → resolve → enrich → suppress → land) is the SHARED pipeline (Phase 04)
}
```

Connectors are **registered** (a registry like `apps/workers/src/register.ts`), never imported by the pipeline.
v1 connectors: `admin_upload` (wraps `runImport`/bulk), `chrome_extension` (Phase 06), `enrichment` (Phase 07).
Framework-only (later): `crm`, `web_form`, `email_signature`, `partner`, `marketplace`, `api`.

### 4.3 Evidence write (the P01 foundation)

Before resolution, each observation appends a `source_records` row (immutable): `{ source, collectedAt,
contentHash, rawData, tenantId, workspaceId, confidence }`. Resolution (Phase 04) links it to a cluster via
`match_links`. The golden record becomes a **projection** over these (Phase 05). **Dual-write window:** the
shipped deterministic landing keeps working; the evidence write is added alongside, behind a flag, then becomes
the source of truth once the projector lands.

## 5. Database design

- New: `ingestion_jobs` (per envelope: source, status, counts, idempotency_key — mirrors `import_jobs`), `source_records`
  **writer** (schema exists). Reuse: `import_jobs`/`_chunks`/`_rows` for the bulk path.
- RLS: tenant/workspace-scoped overlay; platform-source ingests via `withPlatformTx`. Raw payloads are PII →
  encrypted at rest + retention-swept.

## 6. API design

- `POST /api/v1/ingest` (per-tenant, idempotency-key) — the unified entry; returns a job handle.
- `GET /api/v1/ingest/:jobId` — status/counts.
- Admin cross-tenant ingest + connector config under `/api/v1/admin/data/ingest/*` (`data:manage`).

## 7. Workflows · Dependencies · Edge cases

- **Workflow:** envelope → validate → stage/enqueue → per-record (content-hash dedup → evidence write → Phase-04
  pipeline) → job rollup → audit.
- **Dependencies:** `source_records` writer (P01), the queue registry, the object store (P13 for bulk).
- **Edge cases:** partial-batch failure (per-record isolation, like `runImport`); duplicate re-delivery
  (idempotency); a connector that maps to zero canonical fields (reject with reason); consent missing on an
  extension/web-form envelope (reject, Phase 09).

## 8. Migration · Rollback

- **Migration:** add `ingestion_jobs` + the `source_records` writer behind `INGESTION_EVIDENCE_ENABLED`; route
  existing `runImport` through the contract as the first connector (no behavior change when the flag is off).
- **Rollback:** flag off → the shipped import path is unchanged; evidence rows are additive (safe to leave).

## 9. Testing · Security · Scalability

- Tests: idempotent re-delivery returns first result; per-record dedup; cross-tenant isolation on ingest; consent
  rejection. Security: every ingest tenant-scoped + audited; raw PII encrypted; suppression respected downstream.
  Scale: queue + object-store staging + back-pressure; bulk via COPY (P13).

## 10. Implementation Checklist

- [ ] `source_records` writer + `ingestion_jobs` (flagged) · [ ] connector port + registry · [ ] `runImport` as the
  first connector · [ ] `POST /ingest` + status · [ ] idempotency + content-hash dedup · [ ] itests (idempotency,
  isolation, consent). **Depends on:** Phase 04 (the shared post-ingest pipeline) + Phase 05 (the projector).
