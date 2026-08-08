# Contribution Network — architecture, placed in the monorepo

**Scope:** the brief's §2 (contribution network), §3 (central data-management layer), §8 (who reads / who
writes), §9 (extension as a contribution layer). Every stage below names the **workspace package or app that
owns it** and the **table it writes**. Nothing here is an abstract box; if a stage has no monorepo home yet,
it says so.

**Why this document exists separately:** the contribution lifecycle is the one part of the brief that
crosses every deployable process in the repo. Designing it as a diagram and then hunting for a home is how
the "each app maintains its own copy of the record" failure the brief warns about actually happens. So the
placement *is* the design.

---

## 0. The monorepo facts this design must obey

These are mechanically enforced by `.dependency-cruiser.cjs` via `bun run lint:boundaries`. They are not
style preferences — a violating import fails CI.

| Rule | Effect on this design |
|---|---|
| `apps-never-import-apps` | Two deployable processes coordinate **only** through HTTP, a queue, or the database. There is no "just import the forge parser from the API." |
| `no-deep-import-from-app` | An app reaches a package through its `index.ts` only. Every new contribution capability needs a deliberate public surface, not a reach-in. |
| `extension-stays-thin` | `apps/extension` may never import `@leadwolf/db` or `@leadwolf/integrations`. The extension **structurally cannot** touch canonical records — the brief's §9 requirement is already a build-time guarantee, not a convention. |
| `forge-capture-sdk-stays-thin` | `@leadwolf/forge-capture-sdk` imports **only** `@leadwolf/types`. It ships into the untrusted MV3 process. |
| `core-must-not-import-integrations`, `forge-core-must-not-import-integrations` | Providers are adapters behind ports. Enrichment/verification vendors never leak into the pipeline core. |
| `types-is-a-leaf`, `config-imports-only-types` | Shared contribution types live in `@leadwolf/types` and can be depended on from anywhere, including the extension. |
| `no-circular` | The pipeline is a DAG. Stages hand off forward through tables and queues, never by calling back. |

**Repositories in `packages/db/src/repositories/` are the only data-access layer** (CLAUDE.md), reached
through the tenancy seams `withTenantTx` / `withReplicaTx` / `withPrivilegedTx` / `withErTx` /
`withForgeTx` / `withPlatformTx`. That is the mechanism by which "one central data-management layer" is
enforced — it is already in place and needs no invention.

---

## 1. The pipeline as built, stage by stage, with its monorepo address

The brief's lifecycle — Source → Collection → Normalization → Validation → Verification → Dedup →
Enrichment → Confidence → Storage → Distribution → Continuous updates — maps onto shipped code:

| # | Stage | Lives in | Writes |
|---|---|---|---|
| S0 | **Collect** — durable client buffer, idempotency key = SHA-256(sourceUrl ␀ fields), survives service-worker death | `apps/extension/src/background/queue/captureQueue.ts` + `scheduler.ts` | IndexedDB only (client-side) |
| S1 | **Land** — verbatim, idempotent on a **server-recomputed** content hash | `packages/forge-core/src/ingest.ts` (`landEnvelope`), called by `apps/forge-api/src/features/captures/routes.ts` (`POST /v1/captures`) | `forge.raw_captures`, `forge.capture_batches`; large payloads to object storage under a **tenant-prefixed** key |
| S2 | **Parse / normalize** — versioned parsers, no LLM for structured payloads | `packages/forge-core/src/parseStage.ts`, `parser.ts`, `parserRegistry.ts`, `parsers/voyagerProfile.ts`; run by `apps/forge-worker` | `forge.parsed_records`, `forge.parsers`, `forge.parser_versions` |
| S3 | **Extract** — candidate facts out of unstructured text | `packages/forge-core/src/extraction.ts` (declares `ExtractionPort`) | `forge.extraction_runs`, `forge.extraction_candidates` |
| S4 | **Validate / verify** | `packages/forge-core/src/verification.ts`; `apps/workers/src/queues/reverification.ts`, `reverificationSweep.ts`; `verification_jobs` | `forge.verified_records`, `forge.verified_record_events` |
| S5 | **Resolve identity / dedup** | `packages/forge-core/src/er.ts`, `blindIndex.ts`; `apps/workers/src/queues/erSweep.ts`, `dedup.ts`, `masterBackfill.ts` | `forge.match_candidates`, `forge.match_links`, `forge.merge_log`; public `match_links`, `source_records` |
| S6 | **Promote to canonical** | `packages/db/src/repositories/forgeSyncRepository.ts` + `masterGraphRepository.ts`, via `withErTx` | `master_*` tables, `forge.master_id_map`, `forge.sync_state`, `forge.sync_outbox` |
| S7 | **Provenance** — every promotion appends a field-grain assertion | `packages/db/src/repositories/evidenceRepository.ts`; flag `PROVENANCE_EVENTS_ENABLED` | `provenance_event` (range-partitioned) |
| S8 | **Confidence / survivorship** | `packages/core/src/prospect/fieldProvenance.ts` (pure fold); projector via `projectorRepository.ts`, `apps/workers/src/queues/projectionSweep.ts` | `master_*.field_provenance` + `prov_hwm` |
| S9 | **Distribute** — tenant overlay, reveal, search, CRM | `revealRepository`/`revealContact`, `searchRepository`, `apps/workers/src/queues/crmSync.ts` | `contacts`, `accounts`, `contact_reveals`, `credit_ledger` |
| S10 | **Govern** — consent, quarantine, human review, audit | `apps/forge` (operator console: `features/review`, `captures`, `parsers`, `sync-status`), `apps/forge-api/src/middleware/capability.ts` | `forge.contributor`, `contributor_consent`, `quarantine`, `review_tasks`, `approval_requests`, `forge_audit_log` |
| S11 | **Erase** — DSAR fan-out across the pipeline | `packages/forge-core/src/dsar.ts`, `apps/workers/src/queues/dsar.ts`, `dsarRepository` | `dsar_requests`, `suppression_list`, cascades to channels |

**Assessment: the brief's §2 lifecycle is ~85% built.** What is missing is not the pipeline — it is
(a) a second front door that shouldn't exist, (b) the shared capture SDK that is currently a stub, and
(c) any path at all for the new entity families. Those three are §4.

---

## 2. Finding: there are two ingest front doors

- `apps/extension` drains to **`POST /ingest`** on `API_BASE` — the main `apps/api` (`scheduler.ts:22` →
  `ctx.api.ingest`, `background/api/client.ts:74`). Its own error handling documents the response
  `400 "No connector is registered for source 'chrome_extension'"`, so this path runs through the API's
  connector registry.
- `apps/forge-api` exposes **`POST /v1/captures`** (`features/captures/routes.ts:27`) and calls
  `landEnvelope`, which is where the hardened behaviour lives: server-recomputed content hash, server-measured
  byte size, tenant-prefixed object keys, post-commit parse enqueue.

The `landEnvelope` comments are explicit about why each of those is server-authoritative — a client-declared
`byteSize: 0` once cleared four separate caps and forced a multi-megabyte payload inline into JSONB, and a
client-declared `contentHash` is a cross-tenant pre-claim/poisoning oracle. **Any ingest path that does not
route through `landEnvelope` does not inherit those protections.**

**Design decision CD-1: one front door.** The extension's capture path must terminate in `landEnvelope`.
Either `apps/api`'s `/ingest` delegates to `packages/forge-core` (allowed — an app importing a package), or
the extension is pointed at forge-api's `/v1/captures`. `apps-never-import-apps` forbids the third option of
`apps/api` importing forge-api's route module.

Recommendation: **`apps/api` `/ingest` becomes a thin adapter over `landEnvelope`.** It keeps the extension's
auth, tenancy, and rate-limit middleware where they already work, keeps one public API origin for the
extension, and moves the hardened logic under it. `forge-api`'s `/v1/captures` stays for operator/bulk flows.

`[VERIFY IN PHASE 4]` whether `apps/api`'s `/ingest` already delegates this way — this reading is from the
extension side and the connector-registry error string. It is a two-file check, not an assumption to build on.

---

## 3. Write-ownership matrix (the brief's §8, answered concretely)

**Canonical records (`master_*`, `provenance_event`) have exactly one writer: the ER/promotion path, through
`withErTx`.** Everything else proposes; nothing else writes. This is enforced structurally, not by policy —
Layer 0 has no grant to `leadwolf_app` (`masterGraph.ts:6-9`), so an app-role connection physically cannot
write it.

| Process | Layer 0 `master_*` | `provenance_event` | `forge.*` | Layer 1 (`contacts`/`accounts`) | Billing/credits |
|---|---|---|---|---|---|
| `apps/extension` | ✖ — cannot even link `@leadwolf/db` | ✖ | ✖ (proposes via HTTP) | ✖ | read balance only |
| `apps/api` | ✖ | ✖ | **W** raw_captures (via `landEnvelope`) | **RW** (tenant-scoped, RLS) | **W** |
| `apps/forge-api` | ✖ | ✖ | **RW** | ✖ | ✖ |
| `apps/forge-worker` | ✖ | ✖ | **RW** (parse/extract/verify) | ✖ | ✖ |
| `apps/workers` | **W** via `withErTx` (ER, backfill, projection) | **W** | **R** | **W** (import, enrichment, CRM) | **W** (metering) |
| `apps/web` | ✖ | R (badge, aggregated) | ✖ | **RW** | R |
| `apps/admin` / `apps/forge` | ✖ | R | **RW** governance tables | R (via staff paths) | R |

Two rules fall out and should be added as **new dependency-cruiser rules**, because right now they are
convention only:

- **`only-workers-write-master-graph`** — forbid `masterGraphRepository`'s write surface from being imported
  outside `apps/workers` and the ER paths.
- **`no-canonical-write-from-web`** — forbid `apps/web` / `apps/admin` from importing the Layer-0 write
  seam at all.

Mechanically enforcing the ownership matrix is what stops the brief's stated failure mode — multiple apps
independently maintaining their own version of a prospect — from re-emerging under time pressure. A comment
does not survive a deadline; a failing CI gate does.

---

## 4. Gaps, in monorepo terms

### G1 — `@leadwolf/forge-capture-sdk` is a stub

Its own header says it is *"the envelope-v2 builder + content-hash + size/PII guards shared by the MV3
extension and the forge-api ingest validation."* The package contains one line:
`export const FORGE_CAPTURE_SDK_VERSION = "0.0.0"`.

Consequences today: the extension and forge-api do not share an envelope builder, so the client and server
can drift; and **the PII guard does not exist**. CLAUDE.md hard constraint 4 forbids capture of email/message
body content — that is currently enforced by the content script's extraction code being careful, not by a
guard on the envelope. A mechanical guard belongs in this package precisely because it is the one module
both sides link.

**Fix:** build the envelope-v2 builder, the client-side content hash (advisory — the server still
recomputes), the size caps, and a field-allowlist PII guard here. It imports only `@leadwolf/types`, so it
is legal in the extension. This is the highest-value small package in the whole plan: it is where "the
extension cannot contribute something it shouldn't" becomes a build artifact.

### G2 — `EnrichPort` / `VerifyPort` are declared with no adapters

`packages/forge-core/src/ports.ts` declares both; the comment says *"Enrichment/verification adapters land
with their docs."* The pipeline's enrichment and verification stages therefore have a seam but no
implementation on the forge side. `packages/integrations` is the legal home for adapters
(`forge-core-must-not-import-integrations` means core declares, integrations implements).

### G3 — no contribution path exists for technology, product, or market signals

Every parser, extractor and promotion path is person/company shaped. `forge.parsers` /
`forge.parser_versions` is a **registry**, which means new entity families are *registered parsers plus new
promotion targets* — not a new pipeline. That is the single most important structural finding for the
Phase 3 design: **the technology/product/signal work does not need a new front door, a new queue topology,
or a new governance model. It needs new parsers, new extraction targets, new canonical tables, and new rows
in the ownership matrix.**

Concretely, the new entity families plug in at exactly three points:
1. `packages/forge-core/src/parsers/` — a parser per source shape (job posting, DNS/MX record, filing, press release).
2. New canonical tables + repository writes at S6, promoted through the same `withErTx` seam.
3. New `provenance_event.entity_type` values at S7 — the column is a `varchar(20)` with no FK **by design**
   ("it spans both layers and stays re-pointable"), so adding `technology` / `signal` / `product` costs
   nothing structurally.

### G4 — two worker processes, undocumented split

`apps/forge-worker` (7 modules: parse/extract/verify pipeline) and `apps/workers` (46 queues: everything
else). The split is real and defensible — forge-worker is the contribution pipeline, workers is the product
platform — but it is nowhere stated, and new contribution work will land in the wrong one by default.
**Fix: one paragraph in the architecture doc and a `README.md` in each app.** Cheap; prevents drift.

---

## 5. Where new code goes (the placement decisions)

| New capability | Package/app | Why there |
|---|---|---|
| Envelope v2 builder, size caps, PII field allowlist | `packages/forge-capture-sdk` | Only package legal in both the extension and forge-api |
| Technology/product/signal **parsers** | `packages/forge-core/src/parsers/` | Registry already exists; pure, unit-testable, no DB |
| Technology/product/signal **canonical tables** | `packages/db/src/schema/` (new files, mirroring `masterGraph.ts`'s system-owned posture) | Layer 0 = no tenancy columns, isolated by access path |
| Their **repositories** | `packages/db/src/repositories/` | The only data-access layer, no exceptions |
| Confidence decay function | `packages/core/src/prospect/` beside `fieldProvenance.ts` | Pure fold, no I/O, testable against the R4 half-life table |
| Provider adapters (enrich/verify/technographics) | `packages/integrations` | Ports live in core; adapters live here (boundary rule) |
| Decay + signal sweeps | `apps/workers/src/queues/` | Platform-side scheduled work, not contribution-pipeline work |
| Profile UI (company/prospect/technology/product) | `apps/web/src/features/<entity>/` | Feature-folder rule; no cross-feature imports |
| Operator review of new entity types | `apps/forge/src/features/review/` | Governance console already owns review tasks |

---

## 6. What this means for the contribution *network* (the product question)

The brief asks how contributions are identified, ranked, corroborated, and how bad data is kept out. The
mechanisms are already present and only need to be *pointed at the new entity families*:

- **Identified:** `provenance_event.contributor_ref` is an opaque UUID with no FK, resolvable only behind a
  separate schema and role. Withholding `USAGE` on that schema is the actual privacy wall for outcome C-02 —
  a contributor's identity is not merely hidden in the UI, it is unreachable from `public`.
- **Corroborated:** `source_count` on channels and edges, plus `count(DISTINCT contributor_ref)` computed
  **inside the database** so the reference never leaves it as a value (`idx_prov_event_badge`).
- **Ranked:** `source_name` + the survivorship fold. Research R1 gives the weighting shape — active sources
  outrank passive ones — and R6 names the one input not yet weighed (completeness).
- **Kept out:** `forge.quarantine` + `review_tasks` + `approval_requests`, and the structural control from
  research R8 — **there is no reward to farm**, so fabrication has no payoff. That is rule 7 working as a
  fraud control rather than as a restriction.
- **Consent:** `forge.contributor_consent` + `consent_records`, with the consent snapshot captured *on the
  envelope itself* (`landEnvelope` writes `consentSnapshot` into the raw capture row) — so the lawful basis
  is frozen at collection time, not reconstructed later.

**The open compliance item from research R8 stands:** Apollo notifies newly-added contacts in ~14
jurisdictions. Whether TruePoint has a notification-on-first-storage flow is unresolved and is a Phase 4
checklist item against `docs/strategy/09-compliance.md`.

---

## 7. Decisions recorded here

| ID | Decision | Status |
|---|---|---|
| CD-1 | One ingest front door; `apps/api` `/ingest` becomes a thin adapter over `forge-core`'s `landEnvelope` | Proposed — needs the two-file verification in §2 |
| CD-2 | New entity families reuse the existing pipeline: new parsers + new promotion targets + new `entity_type` values. No new front door, queue topology, or governance model | Proposed |
| CD-3 | Build out `forge-capture-sdk` for real; the PII guard becomes a build artifact rather than a convention | Proposed |
| CD-4 | Add two dependency-cruiser rules encoding the write-ownership matrix | Proposed |
| CD-5 | Document the `forge-worker` vs `workers` split | Proposed |
