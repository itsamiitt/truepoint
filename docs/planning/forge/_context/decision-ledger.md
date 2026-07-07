# TruePoint Forge — Decision Ledger (frozen vocabulary — every doc obeys)

> **Purpose.** These decisions are LOCKED for the whole 20-doc suite. Use these exact names, shapes, and
> positions in every document. If a doc needs to deviate, it must raise it in its `## Open questions` and
> flag the Decision Ledger — never silently diverge. Consistency review (Stage 8) greps for these terms.

## L1 — Identity & naming
- **Product / repo / npm scope:** **TruePoint Forge** · repo **`truepoint-forge`** · scope **`@forge/*`**.
  *(Collides with Atlassian Forge — OQ-1; user chose it deliberately. Docs may use the token `{{PLATFORM}}`
  in reusable snippets, but prose says "TruePoint Forge". No stray `{{PLATFORM}}` in final output.)*
- **Relationship to TruePoint:** Forge is a **separate, internal, staff-only** data-operations platform (its
  own DB/apps), upstream of the TruePoint production CRM. Brand stays TruePoint; TruePoint's own code scope
  stays `@leadwolf/*`. Forge does **not** rename or fork TruePoint's `@leadwolf/*` packages — it consumes
  pinned slices where useful (`@leadwolf/ui`, a pinned `@leadwolf/types` subset) and otherwise stands alone.

## L2 — The four data layers (medallion) — exact table/stage names
| Layer | Name | What it holds | Key property |
|---|---|---|---|
| Bronze | **`raw_captures`** | verbatim payloads (extension raw API responses, bulk import blobs, provider raw JSON) | immutable; `content_hash` UNIQUE → idempotent; large blobs in object store, pointer in row |
| Silver | **`parsed_records`** | normalized candidate fields from a **versioned parser** | FK → raw_capture + parser_version; field-level provenance; parse errors captured, not fatal |
| Gold | **`verified_records`** | canonical golden entities after AI extract + human approval + dedup/merge | authoritative; confidence + merge lineage; the ONLY layer that syncs |
| Sync | **`sync_state`** + **`master_id_map`** | per-record sync status + Forge-id ↔ TruePoint-master-id mapping | states `pending / synced / failed / superseded` |

- Always write the layer flow as **`raw_captures → parsed_records → verified_records → (sync) → TruePoint master graph`**.
- Never invent alternate layer names (no "bronze_table", "staging_final", etc.) — use the four above.

## L3 — Ingestion (envelope v2)
- The extension pivots to **MAIN-world raw API interception** (ADR-0046) and posts **envelope v2** to
  **Forge's** ingestion API, **never** to TruePoint's `/api/v1/ingest`.
- **Envelope v2** = TruePoint's `ingestionEnvelope` (ecosystem-facts §A) **plus** per-record:
  `raw_payload` (verbatim, opaque), `endpoint` (e.g. `voyager/identity/profiles`), `schema_version`,
  and envelope-level size cap + gzip + chunking. It is a **new Forge-owned contract**, not an edit to
  `packages/types/src/ingestion.ts`.
- Ingest-time dedup = `content_hash` UNIQUE on `raw_captures` (mirrors `source_records.content_hash`).
- Abuse control extends the **`checkCaptureRate`** posture (record-volume throttle, fails open).

## L4 — Entity resolution ownership (ADR-0047)
- **Forge owns ER.** raw→parse→AI→verify→**dedup/merge/survivorship** all run in Forge's ops DB.
- TruePoint's `packages/core/src/er/` + `erSweep` stay **inert for ingestion**. TruePoint `master_*` becomes
  a **downstream serving projection** fed only by the sync.
- Forge's ER engine is built on the same math as TruePoint's (Fellegi-Sunter; ecosystem-facts §C) and MAY
  relocate/adapt that scorer, but it is Forge-owned code in `@forge/core`.

## L5 — The sync contract (ADR-0047)
- **Transport:** HTTP **push**, a dedicated versioned server-to-server endpoint on TruePoint:
  **`POST /api/v1/master-sync`** (versioned; e.g. `X-Forge-Sync-Version`). Driven by a Forge **outbox +
  sync worker**.
- **Idempotency on TruePoint:** upsert keyed on `source_records.content_hash` UNIQUE + master blind-index.
- **PII:** the sync honors the bytea AES-GCM + HMAC-blind-index scheme (ecosystem-facts §B) — Forge encrypts
  + computes blind indexes before the master upsert; clear PII never crosses in a queryable column.
- **Review status:** synced `match_links.review_status = 'confirmed'` (resolution happened upstream).
- **Implementation on TruePoint side:** a new **`forge_sync` connector** (reuses the connector-registry
  pattern) bound to a **system principal** — a client-credentials service JWT (`aud=truepoint-api`,
  `scope=master-sync`), **never** a human/tenant session.
- **Rejected:** direct cross-DB writes (couples to RLS/encryption internals; bypasses business rules) and
  event-bus-as-primary (extra infra) — both recorded as considered-and-rejected; event-bus is a future option (Doc 20).

## L6 — Auth
- **Operators:** SSO via OIDC against **`auth.truepoint.in`**, mapping the existing **`data_ops` staff role
  + `data:*` capabilities**. Forge's dashboard mirrors `apps/admin`'s auth client (in-memory access token,
  PKCE redirect, silent refresh, `fetchWithAuth`).
- **Machine sync:** the separate service credential in L5 — never a human session (mirrors ADR-0045 isolation).
- **Capabilities:** reuse/extend `data:read|manage|review|export`; introduce Forge-specific ones only if a
  capability genuinely has no TruePoint analog (flag any new capability in the doc's Open questions).

## L7 — Tech stack (mirror TruePoint; ecosystem-facts intro)
- Bun 1.3.14 + Turbo + Biome · Hono API · Postgres + Drizzle (**hand-authored migrations**, `generate` unsafe)
  · BullMQ + Redis (retry+jitter / DLQ / leaderLock / transactional outbox) · Next.js 15 dashboard +
  `@leadwolf/ui` · **Anthropic** for AI extraction (ADR-0023 posture) · **object storage (S3/MinIO)** added
  for large raw blobs (Postgres holds metadata + pointer; small profile JSON MAY stay JSONB).

## L8 — Monorepo layout (`truepoint-forge`)
```
apps/     dashboard · api · workers
packages/ types · db · core · ai · sync · capture-sdk · config · ui
```
- `apps/dashboard` (Next 15 operator console) · `apps/api` (Hono: capture-ingest + dashboard BFF + sync-status)
  · `apps/workers` (BullMQ: parse · extract · resolve · verify · quality · sync · maintenance).
- `packages/core` owns the parser framework + ER/dedup + quality/validation rules + merge/survivorship;
  `packages/sync` owns the versioned sync client + reconciliation; `packages/capture-sdk` (interceptor helpers
  + envelope v2 builder + size/PII guards) is shared with the extension. dependency-cruiser mirrors TruePoint
  (imports through each package's `index.ts`; `apps/*` never import another app).

## L9 — Gap-ID vocabulary
- Use **`G-FORGE-NN`** for gaps this suite identifies/closes; map to `28-enterprise-readiness-audit.md`
  gap-IDs where an existing TruePoint gap is relevant. Gap-IDs are unique across the suite.

## L10 — New ADRs (in TruePoint `docs/planning/decisions/`)
- **ADR-0046** — Raw API interception as primary capture (amends **ADR-0043 decision #4**; legal/ToS/abuse
  risk register + kill-switch + per-tenant gating + compliance firewall).
- **ADR-0047** — TruePoint Forge as master-graph upstream + versioned sync contract (Forge owns ER; `master_*`
  = serving projection).
- Forge's own **repo-internal** decisions start a fresh `ADR-0001…` series inside `truepoint-forge/docs/`
  (referenced but not authored in this TruePoint-side suite unless a doc needs one).

## L11 — Open-questions register (carried in 00-README + each doc)
OQ-1 name collision · OQ-2 interception legal sign-off (GA-blocking, not planning-blocking) · OQ-3 sync is a
one-way door (Forge owns ER) · OQ-4 raw-blob substrate (object store vs JSONB; default object-store-large /
JSONB-small) · OQ-5 migration/retirement of TruePoint's dark `chrome_extension` connector · OQ-6 capture-SDK
single-sourcing (`@forge/capture-sdk` shared vs fork).
