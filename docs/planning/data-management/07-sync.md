# 07 — Bi-directional CRM Sync (design)

> **Gate:** PLAN (design). Cites `00-overview.md` DM9 and `01-research-brief.md §5.5`.
> **Posture: largely net-new** — `26-integrations-data-delivery.md §2` sketches bidirectional CRM
> sync in one paragraph (M10) but designs **no conflict-resolution mechanism, dedup-on-write, or
> field-direction**; nothing is built (CRM names appear only as import `source_name` values). This
> doc designs the conflict model, **reusing the existing primitives** rather than inventing. **No code
> changes in this gate.**

## 1. Reuse map (cite — do not re-derive)

| Already designed / built | Where |
|---|---|
| CRM sync framing (Salesforce/HubSpot/Pipedrive OAuth, field mapping, M10, `integrations` table) | `26 §2`; `05-features-modules.md §14` |
| No-lock-in / portability policy | ADR-0012; `26 §1` |
| Event backbone for outbound delivery (idempotent, at-least-once) | `20`; `26 §1/§4` |
| Outbound webhooks (signed, retries, DLQ) + the SSRF guard | `26 §4`; `core/src/webhooks/*`; `01 §6` R4 |
| Import pipeline (CSV/XLSX, staging, async) — the inbound counterpart | ADR-0036; `core/src/import/*` |
| Field-level source-of-truth substrate: `field_provenance` (`src`, `conf`, `pin`) | `04-provenance.md §2.3`; `@leadwolf/types fieldProvenance.ts` |
| Dedup-on-write keys: the deterministic match keys | `02-identity-and-dedup.md`; `enrichment/matchKeys.ts` |
| Suppression/reveal gating on export (only owned/revealed data leaves) | `08 §3.2`; `26 §8.3` |
| Reverse-ETL / export center / scheduler | `26 §5/§8` |

**Conclusion:** the connectors, OAuth, event backbone, and the primitives a sync needs all exist or
are designed. What's missing is the **conflict-resolution design** — and `01 §5.5` (verified) gives
the industry answer.

## 2. Net-new (design here): the conflict-resolution model

### 2.1 Strategy — field-level source-of-truth + LWW tiebreak + review queue (DM9)

Per `01 §5.5`: production CRM sync uses **field-level source-of-truth** (a designated master system
*per field*), with **last-write-wins by timestamp only as a tiebreak** on fields TruePoint owns, and a
**review/exception queue** for contested values. **CRDT is explicitly rejected** for CRM field sync
(CRMs are mutable records over rate-limited REST with no causal metadata).

Concrete per-field ownership for an enrichment product:
- **Customer CRM is master** for **human-touched** fields (anything the rep/customer edited) — never
  overwrite these.
- **TruePoint enrichment is master** only for fields the customer has **not** curated (and only when
  incoming `conf` exceeds a threshold).
- **LWW** applies **only** as a tiebreak among TruePoint-owned fields; never to overwrite a
  CRM-owned/human-edited field.

### 2.2 Never overwrite human-edited fields (reuse `field_provenance.pin`)

The "protect human edits" half is **already modelled**: `field_provenance.pin=true` marks a human
correction that blocks overwrite (`04 §2.3`). Sync reuses it directly — a `pin`ned field is
CRM-master and is **never** written from enrichment, and an enrichment value only overwrites an
un-pinned field when `incoming.conf > current.conf` (or `current` is blank). On a genuine conflict
(both sides changed, neither pinned), write the incoming value to a **staging field** (e.g.
`Enriched_Phone` beside `Phone`) and enqueue a **review** rather than clobbering. This is DM1-clean:
sync consumes the existing provenance substrate, it does **not** add a parallel one.

### 2.3 Dedup-on-write (reuse the match keys)

Never blind-create a record in the customer CRM. Upsert on a **stable key** using the deterministic
match keys (`02`):
- **HubSpot:** contacts auto-dedup on **email**, companies on **primary domain** — but **API-created
  companies are NOT auto-deduped by domain**, so search-then-upsert on Record ID/domain (`01 §5.5`).
- **Salesforce:** rely on **Matching + Duplicate Rules** but **not as the only defense** (some paths
  skip them); search/upsert on an **External ID** (set to TruePoint's stable id) with
  `DuplicateRuleHeader` controlled per request.
This prevents the exact failure (duplicates in the customer's CRM) the customer hired us to avoid.

### 2.4 Per-field sync direction (explicit, not implicit two-way)

Sync direction is a **per-object / per-field setting** (read-only enrich-in vs write-back vs
two-way), configurable per workspace (`26 §2`, `12 §3`), not an implicit bidirectional default. The
default is conservative: **enrich-in** (we read the CRM, fill gaps) + **write-back only** the fields
the workspace opts to publish.

### 2.5 Rate / batch discipline (reuse `18 §9`)

CRM APIs are quota-bounded (SF ~100k req/day +1k/user, Bulk API 15k batches/24h; HubSpot ~190
req/10s, batch 100/request). Design: **batch** (100/call HubSpot, Bulk API for SF), **diff-and-write
only changed fields**, **429 backoff**, ride the **per-tenant queue quotas + backpressure** (`18 §9`)
so one tenant's sync can't starve others. Sync rides the event backbone (`20`) for idempotency.

## 3. Target schema (net-new — greenfield, additive)

| Table | Key columns | Rule |
|---|---|---|
| `integrations` (referenced by `26 §2`, design here) | `tenant_id`, `workspace_id`, `provider` (salesforce/hubspot/pipedrive), encrypted OAuth token, scopes | per-workspace connection; tokens are secrets, never logged/client-exposed |
| `sync_field_policy` | `workspace_id`, `object`, `field`, `direction` (in/out/both), `master` (crm/truepoint), `conf_threshold` | the field-level source-of-truth + direction config |
| `sync_conflicts` | `workspace_id`, `record_ref`, `field`, `crm_value`, `incoming_value`, `status` | the review/exception queue (§2.2) |
| `sync_state` | `workspace_id`, `provider`, `external_id`, `last_synced_at`, cursor | dedup-on-write anchor + incremental sync cursor |

Reuse `field_provenance` (per-field ownership), the match keys (dedup), `audit_log` (every sync write
audited), and `suppression_list` (only owned/revealed, non-suppressed data leaves — `08 §3.2`).

## 4. RLS / scoping implications

All sync tables are **overlay-scoped** (`ENABLE`+`FORCE` RLS on the workspace GUC, DM4); OAuth tokens
are tenant/workspace secrets (KMS-encrypted, server-side only — `truepoint-security`). Sync writes run
under `withTenantTx`. **Only owned/revealed, non-suppressed** fields leave (reuse the export
anti-join, `08 §3.2`) — sync is a delivery path and inherits the same compliance gates as export
(`26 §1`). The webhook SSRF residual (R4) applies to any customer-supplied callback URL — reuse
`assertSafeWebhookUrl` (`01 §6` R4).

## 5. Scale-gate analysis

| Breaks first | Why | Fix |
|---|---|---|
| CRM API rate limits | per-record writes blow the daily quota | batch (100/call), upsert-on-key, diff-only writes, 429 backoff (§2.5) |
| Write fan-out across tenants | many workspaces syncing at once | per-tenant queue quotas + backpressure (`18 §9`); ride the event backbone |
| Conflict-queue growth | many contested fields | bounded by changed-field volume; review queue is a worklist, not a hot path |
| Initial backfill of a large CRM | first full sync is huge | Bulk API / batch import via the staging pipeline (ADR-0036); incremental thereafter via `sync_state` cursor |

## 6. Failure modes

- **F1 — duplicates created in the customer CRM:** prevented by dedup-on-write upsert-on-stable-key
  (§2.3) — the headline failure this design exists to avoid.
- **F2 — sync overwrites a human-edited field:** prevented by `field_provenance.pin` + the
  conf-threshold + staging-field-on-conflict rule (§2.2).
- **F3 — blind two-way sync ping-pong loop:** prevented by explicit per-field direction (§2.4) + a
  time-threshold tiebreak on LWW (`01 §5.5`); never sync a field back that just arrived.
- **F4 — suppressed/unowned data leaves via sync:** prevented by the export-time anti-join + reveal/
  ownership gate (`08 §3.2`); sync inherits export's compliance posture.
- **F5 — OAuth token leak:** tokens KMS-encrypted, server-side, never logged/echoed (security).
- **F6 — a parallel provenance/identity mechanism for sync:** forbidden (DM1/DM6/DM9); sync reuses
  `field_provenance` + match keys.

## 7. Open questions

1. **Native CRM apps vs API-only** + marketplace timing (`26` OQ1) — owner: product.
2. **Unified-API (Merge.dev) vs hand-built connectors** (`05 §14`/`26` open) — Merge speeds breadth
   but abstracts custom objects and leaves conflict resolution to us anyway (`01 §5.5`); decision owner:
   platform + product.
3. **Conflict-queue UX** (who reviews, SLA) — owner: product + `truepoint-operations`.
4. **Pipedrive/other CRMs** scope after Salesforce + HubSpot — owner: product.
