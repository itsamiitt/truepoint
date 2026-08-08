# Phase 2 — Existing System Audit (v1: schema inventory)

**Method:** direct inspection of the repository. Every claim below carries a file pointer. Where a claim is
inferred rather than read, it is marked `[UNVERIFIED]` and becomes a task, not a conclusion.

**Status:** v1 covers the data model. The read paths (API, dashboard, extension, workers, CRM) are audited
in v2.

---

## 1. Scale of what already exists

| Thing | Count | Evidence |
|---|---|---|
| Migrations applied | 99 (latest `0099_short_pet_avengers.sql`) | `packages/db/src/migrations/` |
| Tables in `public` | ~130 | `pgTable(` inventory across `packages/db/src/schema/` |
| Tables in the `forge` schema | 21 | `packages/db/src/schema/forge.ts` |
| Repositories (the only data-access layer) | 120 | `packages/db/src/repositories/` |
| Hand-written RLS policy files | present per-domain | `packages/db/src/rls/*.sql` |

**The single most important audit finding: the brief's premise that this is a schema to be redesigned is
wrong in the direction of *understating* what exists.** TruePoint already has a two-layer canonical
architecture with provenance, entity resolution, encrypted channels, a contributor pipeline, and compliance
machinery. The correct plan is to *complete and extend* it, not to replace it.

---

## 2. The two-layer model, as built

### Layer 0 — system-owned master graph (`packages/db/src/schema/masterGraph.ts`)

Seven tables, deliberately **not** RLS-scoped: no `tenant_id`, no `workspace_id`, no owner column. Isolation
is structural — `leadwolf_app` has no grant; access is via `withErTx` / privileged paths only
(`masterGraph.ts:6-9`).

| Table | Grain | Notable |
|---|---|---|
| `master_companies` | golden company | `primary_domain` (PSL eTLD+1) is the strongest key, nullable + partial-unique so a domainless company is representable; `alt_domains[]`; self-FK `parent_company_id` for hierarchy; `technographics` **jsonb blob**; `field_provenance` jsonb + `prov_hwm` watermark; reserved-but-unindexed `block_key` for future ER blocking |
| `master_persons` | golden person | `linkedin_public_id` partial-unique; denormalized `current_company_id`; precomputed `has_email`/`has_phone` facets so masked search never joins PII tables; `is_suppressed` mirror gating reveal; ER merge tombstone `merged_into_person_id` + `merged_at` with a self-merge CHECK |
| `master_employment` | one row per (person, company) **stint** — SCD2 | `started_on` defaults to `'-infinity'` as an "unknown start" sentinel so unknown-start duplicates collide under `uniq_employment_stint`; at most one `is_primary` edge per person, DB-enforced; carries a derived provenance cache (`asserting_source`, `match_method`, `confidence`, `source_count`, `observed_at`, `last_verified_at`) |
| `master_emails` | (person, email value) | `email_enc` bytea AES-GCM ciphertext, **nullable** (a match-against mint stores only the key); `email_blind_index` HMAC, **globally unique** — the dedup + DSAR/suppression key; status lifecycle enum; append-only (no `updated_at`) |
| `master_phones` | (person, phone value) | same posture, HMAC over E.164 |
| `source_records` | one row per source payload | `content_hash` sha256 **globally unique** → idempotent ingest; `raw_data` verbatim; `match_keys`; `lawful_basis_snapshot`; `resolved_person_id`/`resolved_company_id` set by ER |
| `match_links` | ER output | `cluster_id` *is* the golden entity id (no separate cluster table); `match_probability` (Fellegi-Sunter), `match_method` (`deterministic\|splink\|manual`), `is_duplicate_of` survivor link, `review_status` (`auto\|pending\|confirmed\|rejected`) |

### Layer 1 — tenant overlay (`contacts.ts`, `contactChannels.ts`, `accountChildren.ts`)

`accounts`, `contacts`, `source_imports`, `contact_emails`, `contact_phones`, `account_domains`,
`account_locations` — all RLS-scoped by `tenant_id` + `workspace_id`.

### The provenance spine (`packages/db/src/schema/provenanceEvent.ts`)

`provenance_event` is **field-grain**, `PARTITIONED BY RANGE (recorded_at)`, hand-authored in migration
`0089` (Drizzle cannot express partitioning; the table is deliberately excluded from `schema/index.ts` so
`drizzle-kit generate` never sees it).

It carries exactly the five-tuple the brief's §2 provenance model asks for, and then some:
`entity_type`/`entity_id`/`field`/`action`, `source_type`/`source_name`/`method`, an **opaque**
`contributor_ref` (no FK; resolvable only behind a separate schema + role — that withheld `USAGE` is the
actual C-02 contributor-privacy wall), `lawful_basis`, `payload` (`{}` for PII fields — the log never
becomes a second cleartext PII store), `confidence`, `acceptance_state`, `source_record_id` (`SET NULL`, so
an assertion outlives a reaped payload), and **both** `observed_at` (valid time) and `recorded_at`
(transaction time).

The header comment says "STATUS: DDL only" — **that comment is now stale.** The table is referenced from
`evidenceRepository`, `forgeSyncRepository`, `provenanceBadgeRepository`, `packages/core/src/reveal/
revealContact.ts`, and `packages/core/src/import/runImport.ts`, gated by `PROVENANCE_EVENTS_ENABLED` in
`packages/config/src/env.ts`. **Task: correct the stale header.**

### The contribution pipeline (`forge` schema, 21 tables)

`raw_captures → capture_batches → parsers/parser_versions → parsed_records → extraction_runs/
extraction_candidates → verified_records → verified_record_events → sync_state/sync_outbox → master_id_map`,
plus governance: `contributor`, `contributor_consent`, `quarantine`, `review_tasks`, `approval_requests`,
`forge_audit_log`, and a forge-local ER trio `match_candidates` / `match_links` / `merge_log`.

**This is the brief's §2 lifecycle, already built**: Collection → Normalization → Validation → Verification →
Dedup → Storage → Distribution, with consent and quarantine as first-class tables.

---

## 3. Gap table — brief requirement vs. what exists

Legend: ✅ exists · ◐ partial · ✖ absent

### Prospect intelligence
| Requirement | State | Evidence / gap |
|---|---|---|
| Person profile, name, location, seniority, function | ✅ | `master_persons` |
| Contact info (multi email, multi phone, typed, verified) | ✅ | `master_emails`/`master_phones`, status enums, `last_verified_at` |
| Employment history (multi, dated, resolved to company) | ✅ | `master_employment` SCD2 — **stronger than `cascade 1.md`'s `person_positions`**, which lacks the primary-edge constraint and the unknown-start sentinel |
| Education | ✖ | no table anywhere |
| Skills | ✖ | no table, no taxonomy |
| Languages | ✖ | no table |
| Social profiles (multi) | ◐ | only `linkedin_public_id` as a single column; `sales_nav_links` exists separately |
| External identifiers across sources | ◐ | one column per known source, not a general `person_identifiers` table; `forge.master_id_map` covers the forge side only |
| Contact verification | ✅ | `verification_jobs` + status enums + reverification queues |
| Data freshness | ◐ | `last_verified_at` exists; **no decay curve** (08-architecture calls it "Phase 2 — not built") |
| Confidence scores | ✅ | `confidence` numeric on edges + provenance events; `field_provenance` fold in `packages/core/src/prospect/fieldProvenance.ts` |
| Historical changes | ✅ | `provenance_event` append-only + SCD2 employment |
| Buying / intent / engagement signals | ◐ ⚠ | `intent_signals` exists but is **tenant + contact scoped** with a fixed 9-value enum — it is a per-tenant scoring input, not a canonical market-signal store. And intent data is deferred non-goal **X-04** (see conflict C5) |

### Company intelligence
| Requirement | State | Evidence / gap |
|---|---|---|
| Company profile, industry, size, revenue band | ✅ | `master_companies` |
| Parent/subsidiary hierarchy | ✅ | self-FK, no cascade on delete |
| Company locations (multi) | ◐ | `account_locations` is **Layer 1 (tenant)**; Layer 0 has only `hq_city`/`hq_country` scalars |
| Company contact points (switchboard, generic email) | ✖ | no table |
| Funding | ✖ | no table, no column |
| Technologies | ◐ ⚠ | `master_companies.technographics` **jsonb blob** — unqueryable by technology, no first/last seen, no per-technology confidence or source. This is exactly what `cascade 2.md` argues against |
| Products / services | ✖ | nothing |
| Growth / hiring signals, news, market signals | ✖ | nothing at Layer 0 |
| Business model | ✖ | nothing |
| Website / social presence | ◐ | domains only |

### Technology intelligence
Every element of the brief's technology section is **✖ absent**: no catalog, no categories, no vendor link,
no versions, no adoption edge, no first/last-seen, no detection method, no per-detection confidence or
evidence. The entire capability is one untyped jsonb column. `cascade 2.md`'s core argument — make
`technologies` a first-class entity and separate the catalog from the adoption edge — is **correct and
directly applicable here**, subject to the C2 (infrastructure) and C4 (GPL) conflicts.

### Product intelligence
**✖ entirely absent.** No products, categories, features, product↔company, or product↔technology links.

### Market intelligence
**✖ entirely absent** at the canonical layer. No market segments, competitors, signal store, funding events,
partnerships, acquisitions, leadership changes, or news. `intent_signals` is a tenant-scoped scoring table
and is not a substitute.

### Cross-cutting
| Requirement | State | Notes |
|---|---|---|
| Central data-management layer (no app writes canonical records directly) | ✅ | repositories are the only data-access layer; Layer 0 has no app grant. **Architecturally already enforced** |
| Identity resolution ladder exact→strong→probabilistic→review | ◐ | columns and review states exist (`match_method`, `review_status`, `match_probability`); MVP writes `deterministic`/`auto` only — the probabilistic tier is reserved, not implemented |
| Dedup | ✅ | content hash, blind index, stint unique, merge tombstones |
| Multi-tenancy + RLS | ✅ | hand-written policies, enforced, isolation itests exist |
| DSAR / suppression / retention / consent | ✅ | `dsar_requests`, `suppression_list`, `consent_records`, `retention_*`, DSAR queue |
| Credits / entitlements | ✅ | `credit_ledger`, `entitlement`, `subscriptions`, `plan_templates` |
| Search | ◐ | Postgres-backed behind a `SearchPort` seam |
| Events / outbox | ✅ | `event_outbox`, `projection_outbox`, `worker_outbox`, `usage_event` |
| Partitioning | ◐ | `provenance_event` partitioned; `source_records`, `scores`, `intent_signals`, `provider_calls` all carry a documented *intent* to partition that has not been executed |

---

## 4. Technical debt and inconsistencies found

| # | Finding | Severity | Evidence |
|---|---|---|---|
| D1 | `technographics` as an opaque jsonb blob on `master_companies` — cannot answer "which companies use X", carries no per-technology provenance, first-seen, or confidence, and therefore violates the spirit of invariant 1 (a fact in the graph with no provenance event behind the individual value) | **High** | `masterGraph.ts:69` |
| D2 | `provenanceEvent.ts` header says "STATUS: DDL only. Nothing reads or writes this table" — stale; five modules now use it | Low (doc) | header vs. 18 referencing files |
| D3 | Deferred partitioning stated in comments across four high-volume tables but never executed; the comments explicitly warn not to "silently drop the partitioning intent" | Medium | `masterGraph.ts:307-309`, `intel.ts:3-4` |
| D4 | ER blocking columns (`block_key` on both master tables) are reserved and **unindexed** by design; the probabilistic tier of the match ladder therefore has no working blocking strategy | Medium | `masterGraph.ts:75-77`, `:126` |
| D5 | Freshness decay is designed (`last_verified_at`, `observed_at` vs `recorded_at` separation) but no decay function exists — confidence never ages | Medium | 08-architecture "Decay curves are Phase 2 — not built" |
| D6 | `intent_signals` has a **closed CHECK enum** of 9 signal types; adding a market-signal type requires a migration, and the table is tenant-scoped so canonical signals have nowhere to live | Medium | `intel.ts:78-84` |
| D7 | Company location is modeled at Layer 1 only; two tenants observing the same company's offices cannot corroborate each other | Medium | `accountChildren.ts` vs `master_companies` |
| D8 | Person social/external identifiers are one-column-per-source; each new source needs a migration | Medium | `master_persons.linkedin_public_id` |
| D9 | `master_employment.company_id` is `NOT NULL`, so an unresolved employer cannot be recorded at all — `cascade 1.md` keeps `company_name_raw` alongside a nullable FK, which preserves the assertion until ER resolves it | Medium | `masterGraph.ts:182-187` vs `cascade 1.md` §2.3 |

---

## 5. What the cascade documents get right, and what TruePoint already does better

**Adopt from `cascade 1.md`:** the raw-value-plus-resolved-id pattern on employment (D9); a general
identifiers table (D8); the shared-taxonomy insight — *one* vocabulary serving both person skills and
company technologies makes persona × technographic targeting a join instead of a text-matching project;
and its explicit "what NOT to store" discipline (no signed CDN URLs, no source-UI artifacts).

**Adopt from `cascade 2.md`:** first-class `technologies` entity, catalog vs. adoption-edge split,
bitemporal vendor links so acquisitions never rewrite "who created this", alias resolution, and
first/last-seen driving displacement signals. Its recommendation to **buy** job-posting technographics
rather than build a crawl fleet aligns with TruePoint's non-goal on raw database expansion (S-05).

Note that `cascade 2.md` **contradicts `cascade 1.md`** on exactly this point: `cascade 1.md` §2.5 puts
technologies in the shared `skills` table with `skill_kind='technology'`; `cascade 2.md` §2 explicitly
overrules that and argues for a separate table plus an optional bridge. Phase 3 must resolve it, and the
`cascade 2.md` position is better reasoned — but the bridge table is what preserves `cascade 1.md`'s
genuinely valuable persona × technographic join.

**Already stronger in TruePoint, do not regress toward the cascade design:** encrypted channel values with
HMAC blind indexes (cascade stores contact values in cleartext columns); field-grain provenance with valid
*and* transaction time and an opaque contributor reference (cascade's `contact_attestations` is
contact-points-only and has no contributor privacy model); the two-layer tenant overlay with RLS; the merge
tombstone and reversible-merge discipline; consent, quarantine, and review as first-class contribution-
pipeline tables.

---

## 6. Open audit tasks (v2)

- Read-path audit: which surfaces read Layer 0, and through which repository seam.
- `apps/api` `/api/v1` contract inventory — what an intelligence-profile API would extend.
- Chrome extension capture path end-to-end against the brief's §9 twelve steps.
- CRM sync ownership map (9 tables, dark behind `CRM_SYNC_ENABLED`).
- Worker/queue inventory and where enrichment, verification, and reverification actually run.
- Confirm `[UNVERIFIED]`: whether `accounts` carries its own `technographics` jsonb (grep hit in
  `contacts.ts`), and whether `search` currently exposes any technology filter.
