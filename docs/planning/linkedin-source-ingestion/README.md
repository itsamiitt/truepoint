# linkedin_api source ingestion — schema gap-closure + storage architecture

**Status: BUILT DARK (2026-08-16; amended same day).** Migrations 0112–0116 + the full landing vertical are
on the branch, byte-identical off. Nothing fetches, lands, or emits until the flags below flip — and the
first production `LINKEDIN_API_KEY` is itself a HUMAN GATE (§8).

**Same-day amendment (user instruction, recorded):** "make sure that there can be multiple languages,
position, schools, skills etc along with multiple phone numbers, phone number type and multiple emails and
email type." Positions/schools were already multi-row (`master_employment`/`master_education`). The
instruction OPENED two gates this doc had recorded as closed: **C6 skills/languages** (now
`master_person_skills` + `master_person_languages`, 0116) and **typed multi-channel contribution** (now
`master_emails` multi-row + `email_type`, `master_phones` multi-row + `line_type`, encrypted, behind the
new `LINKEDIN_CHANNELS_ENABLED`). Volunteering was NOT named and stays raw-only.

Outcomes: **[S-09]** (positions history + primary-edge transitions), **[S-13]** (job_change signal fed by a
real producer), **[S-10]** (source_count/observed_at corroboration on every fact), **[S-04]/[S-08]**
(reveal-gated contact block rides the shipped enrichment path), **[A-01]** (every landed field carries
provenance + a lawful basis).

Samples this design was cut against: `source plan/` at the repo root — 3 person payloads
(`schema_version: 1`) + 3 company payloads (`schema_version: 2`). Payload contract:
`packages/types/src/linkedinApi.ts` (zod, passthrough-tolerant, literal-pinned version).

---

## 1. What the source asserts vs what the schema could store (the gap analysis)

### Person payload → schema

| Source field | Pre-0112 state | Resolution |
|---|---|---|
| `profile_id` (urn), `member_id` | nowhere | `master_person_identifiers` rows: `linkedin_member_urn`, `linkedin_member_id` (zero DDL — the 0104 table was built for exactly this) |
| `public_identifier` | `master_persons.linkedin_public_id` ✓ | dual-written: column stays the hot key, identifier row added |
| `headline`, `summary`, `location` (free text) | nowhere | 0112 columns `headline`/`summary`/`location_raw` (business-contact class, 09-compliance rule 3) |
| `positions[]` | `master_employment` ✓ (0105 raw-name survival) | + 0112 `location`/`description`/`start_precision`/`end_precision`; per-position employer resolved by numeric LinkedIn id (below) |
| `educations[]` | `master_education` ✓ (0108) | + precision columns; school LINK-or-MINT by `linkedin_school_id` identifier (distinct namespace — never the company-id column) |
| `contact.emails/phones` | `master_emails`/`master_phones` (multi-row by construction) | **landed by the landing since the same-day amendment** — multi-value, typed (`email_type` 0116; `line_type`), canonicalized (storage-normalized email / E.164), HMAC blind-indexed, AES-GCM encrypted, claim-pattern converged; behind `LINKEDIN_CHANNELS_ENABLED`. Facets `has_email`/`has_phone` raised TRUE-only. The tenant-side reveal/enrich lane is unchanged |
| `skills[]`, `languages[]` | — (C6: "no listed outcome") | **structured since the same-day amendment (C6 gate opened by user instruction)**: `master_person_skills` + `master_person_languages` (0116) — one row per (person, value), citext dedup, `source_count` corroboration, proficiency CHECK vocabulary |
| `pronoun`, `premium`, `open_link`, `job_seeker`, photos, `volunteering[]` | — | **raw-only**: retained in `source_records.raw_data`, dropped at the mapper boundary, no columns. HUMAN GATE to ever structure |

### Company payload → schema

| Source field | Pre-0112 state | Resolution |
|---|---|---|
| `company_id` (numeric) | column + partial unique existed, **unresolvable** | resolver LINK ladder + the domainless MINT (§3) |
| `public_identifier` (slug) | nowhere | `master_company_identifiers` (0113) `linkedin_company_slug` |
| `description`, `website`, `type`, `specialties`, `year_founded`, `logo`, `background_picture` | nowhere | 0112 firmographic columns (`ownership_type` normalized to a CHECK vocabulary; raw display string survives in raw_data) |
| `revenue_range {currency,min,max}` | flat varchar(50) | 0112 structured triple `revenue_min_minor`/`revenue_max_minor`/`revenue_currency` (minor units, funding-table precedent) beside the varchar, which stays and is dual-written ("$5M–$10M") |
| `headquarters {…}` | `master_company_locations` kind='hq' ✓ | mapped; free-text country also fills `hq_country` |
| `headcount.monthly[]` (+ growth, by_function) | **nowhere — the one genuinely new storage problem** | `master_company_headcount` (0114, §2) |
| `entity_urn`, `sales_navigator_url` | — | not stored (derivable from `company_id`) |

### Cross-cutting

- **Partial dates** (`"2018"` / `"2026-05"` / null): dates stay real Postgres `date`s (the `'-infinity'`
  sentinel and the stint-dedup uniques are load-bearing); `start_precision`/`end_precision` record what was
  asserted. One normalizer: `parsePartialDate()` in `@leadwolf/types` (`packages/types/src/partialDate.ts`).
  **Accepted limit, stated:** a source refining "2018" → "2018-03" produces a different stint identity —
  same failure class as the documented sentinel-collision note; cross-source variance is ER's job and
  `source_records` keeps the evidence to re-resolve.
- **provenance_event + master_signals had DDL and zero producers.** This landing is a real producer for
  both (the intelligence-platform handover's "populators are the high-value next work").

---

## 2. The headcount time series — `master_company_headcount` (0114)

The only table in this program that was genuinely undecided anywhere in the planning corpus.

**Shape:** `(id, master_company_id FK cascade, month date CHECK first-of-month, job_function varchar(60)
DEFAULT '' — '' = whole-company total, employee_count int ≥0, source_name, observed_at, created_at)`,
**PK (master_company_id, month, job_function)** = the upsert target.

**PARTITION BY HASH (master_company_id), 32 static partitions.** Why not the 0103 RANGE precedent — three
forcing facts, recorded so nobody "fixes" it back:

1. It is an **upsert** table. A partitioned unique must include the partition key; RANGE on `observed_at`
   would degrade "one row per month" into "one row per refetch" — the 0085 trap.
2. RANGE on `month` satisfies the unique but `ensure_month_partitions` (0102) creates partitions
   **forward-only**, and every first fetch carries ~24 months of history → the backfill lands in DEFAULT
   and permanently blocks later partition creation (0103's own header warning).
3. Every hot read is per-company → hash pruning = single-partition reads. The "who grew this month" feed
   reads `master_signals`, never scans this table.

**Convergence:** `ON CONFLICT … DO UPDATE … WHERE EXCLUDED.observed_at >= stored.observed_at` — overlapping
25-month refetches converge; a stale queued replay no-ops (proven in `masterHeadcount.itest.ts`).

**Growth windows are DERIVED, never stored** (the no-rollup rule): `lag()` over ≤25 rows/company at read
time reproduces the vendor's numbers (itest proof #3); the vendor's growth block survives verbatim in
`source_records.raw_data`. A materialized growth cache was considered and rejected — O(25) per profile read
is cheaper than any cache's invalidation bug surface. Revisit only on p95 evidence.

**Fact + event (the funding precedent):** the series is the fact; `headcount_surge`/`headcount_decline`
(seeded in 0114, family `hiring`, directional-pair vocabulary) are the dated events, emitted only past
`HEADCOUNT_SIGNAL_MIN_PCT` (5% — the samples show endless ±0% months) and idempotent per evidence row.

**ACL:** parent + all `master_company_headcount_pNN` partitions match the `^master_` REVOKE convention
loop; `leadwolf_er` granted on the parent (routed DML checks parent privileges); `mirror_partition_acl`
(0102) sweeps partitions at the end of every migrate. Itest asserts partition-by-name denial.

---

## 3. Identity — resolver extension + `master_company_identifiers` (0113)

`master_company_identifiers` is the company twin of the person table (audit-D8 argument verbatim: ids are
the axis that grows per source; a column per id kind means a migration per vendor). `(id_type, id_value)`
globally unique = the ER join key. The `linkedin_company_id` column **stays** (hot, partial-unique since
0017) and is dual-written; 0113 backfills it into the table, byte-for-byte the 0104 person pattern.

**FRONT-END CONTRACT (recorded user decision, 2026-08-16): external numeric ids are INTERNAL LINK METADATA
ONLY.** `linkedin_company_id`, `linkedin_school_id` and the member id/urn exist purely to raise
prospect↔company and prospect↔school link accuracy in the resolver ladders — they are never surfaced in any
customer-facing DTO, API response, or UI. Enforcement is structural, not conventional: they live only on
Layer-0 `master_*` tables, from which `leadwolf_app` is REVOKEd on every migrate; no `apps/api` feature or
`@leadwolf/types` customer DTO references them (verified by grep). What the front-end may show stays
URL-shaped (profile slug, company page URL).

id_type vocabulary written today:

| table | id_type | value |
|---|---|---|
| person | `linkedin_public_id` | slug (pre-existing) |
| person | `linkedin_member_urn` | `profile_id` ("ACwAA…") — immutable, strongest |
| person | `linkedin_member_id` | canonical decimal string |
| company | `linkedin_company_id` | numeric id (mirrors the column) |
| company | `linkedin_company_slug` | `public_identifier` |
| company | `linkedin_school_id` | legacy school-id namespace — **never** written into the
`linkedin_company_id` column (a cross-namespace collision on the partial unique would silently merge a
school into a company) |

**`resolveForImport` ladders** (`masterGraphRepository.ts`; byte-identical when the new keys are absent):

- Person LINK: `linkedin_public_id` column → identifier `linkedin_member_urn` → identifier
  `linkedin_member_id` → `email_blind_index`. Slug stays first (shipped behavior stable); urn/member-id
  outrank email because they are immutable while an email can be shared or recycled. First hit wins;
  cross-key divergence is the ER sweep's job.
- Person MINT: **still requires slug or email** — the identifier keys are deliberately LINK-only. A mint
  keyed only on an identifier-table row would leave the fresh row with no dedupable key of its own unless
  the caller remembers to attach the identifier afterwards — the junk-identity trap the keyless guard
  exists to prevent. (This deviates from the original plan sketch, which counted the new keys as mintable;
  the payload always carries `public_identifier`, so nothing real is lost.)
- Company LINK: `primary_domain` → `linkedin_company_id` column (**newly reachable** — the shipped partial
  unique finally has a probe) → identifier `linkedin_company_slug`.
- Company MINT: by domain (shipped, now also stamping the LinkedIn id when the probe carried one), or the
  **new domainless mint keyed on `linkedin_company_id`** — required, else every position employer (numeric
  id, no domain) would stay permanently unresolved. Schools mint via
  `masterProfileRepository.resolveSchoolByExternalId` (org_kind='school', identifier-claim convergence).

---

## 4. The landing — `landLinkedinPayload` (one withErTx)

`packages/core/src/sourceLanding/landSourcePayload.ts`, fed by the pure mapper
`mapLinkedinPayload.ts` (the compliance boundary: pronoun/premium/open_link/job_seeker/photos/skills/
languages/volunteering are dropped there and exist only in `source_records.raw_data`).

Order inside the transaction (each step's reason in the file header): resolve → **appendSourceRecord**
(content-hash idempotency chokepoint; `created:false` ⇒ stop — no double corroboration, ever) →
**suppression guard** (an objected person gets the evidence row and *nothing* else — an objection stops
processing, not just revealing) → linkToCluster → **planFieldWrite fold** (pins block the provider; only
`writableFields` land; the map is stamped back in the same UPDATE) → employment stints (per-position
LINK-or-MINT; plain upserts never flip a primary row's currency — only the demote-then-promote transition
does, respecting `uniq_employment_primary`) → education → identifiers → headcount series →
**appendProvenanceEvents** from the ACTUAL writable set (D7: a failed append fails the whole landing) →
signals (`job_change` on a real employer transition; headcount pair past threshold) → enqueueProjection.

Three lanes call it:

1. **Tenant-triggered (contact)** — `enrichContactV2` after its evidence step: when `linkedin_api` was
   attempted and returned a document, the cached rawPayload lands (spend already ledgered in
   `provider_calls`; a retry is spend-safe via the per-field cache). The customer trigger is the
   `RefreshFromSourceButton` on the contact drawer → the SHIPPED `POST /enrichment/contact/:id` with
   `providerOrder:["linkedin_api"]` (a prefix — the waterfall still cascades on a miss).
2. **Tenant-triggered (account)** — `POST /api/v1/enrichment/account/:id` (dark behind
   `LINKEDIN_ACCOUNT_REFRESH_ENABLED`), 202 → the `account_refresh` queue → `core refreshAccount`:
   tenant URL ladder (own `linkedin_company_url`, else the master bridge's numeric id → sales-nav URL;
   neither ⇒ 422), 24h `provider_calls` cache window, daily-budget wall BEFORE spend, one workspace-scoped
   ledger row per fetch (`entityType:"account"` — requestHash namespaces it), then the landing. The button
   lives on the account drawer.
3. **Platform sweep** — `apps/workers/src/queues/linkedinCompanyRefresh.ts`: leader-locked, 6h cadence,
   ≤25 companies/tick (≈100/day deliberate trickle), enumerates LinkedIn-identified companies missing this
   month's totals point (self-terminating each month). Spend control is structural (cap × cadence), NOT
   `provider_calls` — that ledger is workspace-scoped by design and a platform lane must not wear a fake
   workspace id. Skips the tick when the origin chain is empty.

**The fetch layer (REAL vendor contract + origin fleet — second amendment, same day):**

- Contract, verbatim: `POST <origin>/api/linkedin/profile` (prospect) and `POST <origin>/api/linkedin/company`
  with body `{url, include_raw:false, refresh:false, engine:"auto"}` where `url` is any LinkedIn /
  Sales-Navigator URL; responses are the schema_version 1/2 payloads unchanged. `include_raw` stays false
  always (it echoes vendor-side intercepted payloads — the response body already carries everything);
  `refresh:true` bypasses the vendor's 6h capture cache and is used ONLY by the admin test probe.
- **Origin fleet** (`provider_origins`, 0117): many interchangeable origins (data.truepoint.in,
  expo.truepoint.in, …), same contract each, walked as a FAILOVER CHAIN in priority order (recorded user
  decision). Per-origin `x-api-key`, AES-GCM-sealed in the DB (crm-token precedent) with a masked hint for
  the console; the table is app-REVOKEd (explicit — it is NOT master_*-prefixed, so the convention loop
  does not cover it). `core/sourceLanding/originRouter.ts` loads the chain (60s TTL cache; pausing an
  origin takes effect fleet-wide within a minute) with the legacy `LINKEDIN_API_BASE_URL`/`_KEY` env pair
  as the zero-row dev fallback. Outcome taxonomy per attempt: 2xx ⇒ done; 429/5xx/transport ⇒ next origin;
  other 4xx ⇒ the REQUEST is bad, chain STOPS (a different mirror won't disagree); exhausted ⇒ unavailable.
  Passive per-origin health (consecutive_failures / last_ok / last_error) is written on every attempt.
- **The adapter** (`linkedinApiProvider`) is now a thin wrapper over `fetchLinkedinProfile`: URL-keyed
  (subject.linkedinUrl only — no URL, zero-cost miss and the waterfall cascades), ok⇒paid hit/miss with the
  full document as rawPayload, rejected⇒free miss, unavailable⇒free error (breaker counts it). The
  **subject gap is closed**: `getContactForReveal` now selects `linkedin_url`/`linkedin_public_id` and both
  engines set `subject.linkedinUrl = canonicalLinkedinUrl(...)` (one canonical spelling per person so cache
  keys don't fracture; one-time request_hash cold start for contacts with a LinkedIn identity — stated in
  code). The platform sweep fetches companies through the same client via the sales-nav URL built from the
  stored numeric id.

---

## 5. Flags (env-only — Layer 0 has no tenant to key a per-tenant flag on)

| Flag | Gates | Default |
|---|---|---|
| `LINKEDIN_API_KEY` / `LINKEDIN_API_BASE_URL` | any fetch at all (absent = permanent miss = the compliance enforcement) | unset |
| `LINKEDIN_SOURCE_LANDING_ENABLED` | every structured Layer-0 write in `landLinkedinPayload` | off |
| `LINKEDIN_SIGNALS_ENABLED` | master_signals emission from this lane | off |
| `LINKEDIN_CHANNELS_ENABLED` | the landing's master_emails/master_phones contribution (multi-value, typed, encrypted) — separate because channel PII is the co-op boundary's sensitive half | off |
| `LINKEDIN_COMPANY_REFRESH_ENABLED` | registration of the platform sweep | off |
| `LINKEDIN_ACCOUNT_REFRESH_ENABLED` | the customer per-account refresh route + queue | off |

All five surface read-only in the admin console's Env gates panel.

## Ecosystem: extension link-harvest → 30-day fetch → intel hover card (0118)

The full loop between the Chrome extension, the dashboard, and the fetch orchestration (docs/planning
ecosystem; Apollo teardown in `chrome-extension/01a-apollo-teardown-16.3.1.md`):

1. **Capture (URL-only).** On a Sales-Nav search/list page the extension adapter harvests the visible
   result-row anchor URLs (`harvestLinks`, DOM-only — the ADR-0043 gate-free posture) and posts them to
   `POST /api/v1/ingest/linkedin-links` (extension-scoped). The route canonicalizes each via
   `linkedinUrlKey` (all lead/people/slug forms of one profile collapse to one key) and upserts the Layer-0
   **`source_fetch_registry`** (0118) — first-seen only, no fetch inline. Dark behind
   `LINKEDIN_LINK_CAPTURE_ENABLED`. URLs only; the licensed data comes from the origin fleet, never scraped.
2. **30-day fetch.** `source_fetch_registry` has a real `last_fetched_at` written on the fetch ATTEMPT — the
   freshness clock nothing existing could provide (`source_records` skips byte-identical refetches;
   `provider_calls` is workspace-scoped and never advances `called_at` on a hit). The leader-locked worker
   sweep `linkedinLinkFetchSweep` (`LINKEDIN_LINK_FETCH_ENABLED`) selects rows new-or-older-than-30-days and
   runs the shared **`fetchAndLandUrl`** (origin-fleet fetch → `landLinkedinPayload` → `recordFetch`). A
   person landing DERIVES its employer company ids into the registry as company targets, so the same sweep
   fetches companies on the same rule. Layer-0 lane — unmetered, structurally bounded (cap × cadence ×
   registry dedup).
3. **Fetch-on-view.** Opening a profile/company fires `POST /api/v1/ingest/linkedin-links/:kind/fetch`,
   which registers + (unless fresh within 30d) fetches+lands immediately, then re-resolves the caller's
   tenant contact so the card can read the intel by id. Fresh URL ⇒ no vendor call.
4. **Intel hover card.** `resolveByLinkedin` now keeps the resolved masked identity (title/seniority/
   location) on `SubjectStatus`; the account-intelligence reads (employment/education/attributes/headcount)
   are on the extension-scope allow-list for the deep panel. A profile not in the workspace's CRM lands the
   golden data but has no contactId — the card offers the reveal/add path (the reveal-miss posture).

**Model A (ADR-0046 full-payload interception → forge medallion → human verify) stays decided-dark;** the
Phase-B URL-only harvest is the lighter, compliant path that keeps the scraped-payload firewall intact. **Read surfaces + UI** shipped with the
fleet wiring: `GET /contacts/:id/attributes` (skills+languages) and `GET /accounts/:id/headcount` (series;
growth derived client-side) on the account-intelligence seam; web renders Skills & languages chips, the
multi-value typed email/phone lists (S-CH4 arrays), the headcount trend sparkbars, and the two refresh
buttons; admin gets the **Data sources** console (origins CRUD, sealed write-only keys, pause/resume,
passive health, live test probe returning status+latency only).
| `PROVENANCE_EVENTS_ENABLED` (existing) | the event append inside the landing (shipped asymmetric posture) | off |

Tenant-side participation needs no new flag: `provider_configs.enabled` + workspace `provider_prefs`
(0111) already govern which workspaces' waterfalls may try the provider.

**Flag-off proof:** with all of the above unset the tree is byte-identical dark — adapter misses without a
call, the landing returns `flag_off` before touching the DB, the sweep is never registered.

---

## 6. DSAR / erasure (extended in this program)

`dsarRepository.suppressMasterPersons` now also: deletes the subject's `master_person_identifiers` rows
(a surviving handle would re-link the subject on the next ingest — recognition belongs in the deny list),
deletes the 0116 `master_person_skills`/`master_person_languages` rows (a skill/language list keyed to a
person is personal data, the identifier-row class), NULLs the 0112 self-description columns
(`headline`/`summary`/`location_raw` identify a person as surely as the name), and NULLs stint
`location`/`description` (subject-authored prose; the stint's business fact — anonymous node held role at
company — survives, the pre-existing posture). `scanMasterResiduals` counts surviving identifier, skill and
language rows (a scan that does not count a store cannot prove anything about it). Channel rows
(`master_emails`/`master_phones`, now multi-value) were already deleted by the shipped fan-out. Proven in
`dsarLayerZero.itest.ts`.

Company data (identifiers, headcount, firmographics) is business data — deliberately untouched by
person-subject erasure.

---

## 7. Compliance impact statement (09-compliance PR gate)

- **Data elements touched:** person name/headline/summary/location/positions/educations + external profile
  identifiers; company firmographics + headcount. Reveal-gated work emails/phones ride the SHIPPED
  enrichment/channel path, unchanged by this program. Sensitive-adjacent fields excluded from structured
  storage by design (raw-only).
- **Lawful basis:** D6 chain (`resolveLawfulBasis`) — declared ≻ workspace policy ≻ `legitimate_interest`;
  stamped on every provenance event; `acceptance_state` guards untagged captures (n/a here — provider
  source type).
- **Consent surface:** n/a (licensed provider data, not contributor capture). The per-source legal review
  is gate 1 below.
- **Suppression enforcement point:** the landing's step-3 guard (belt) + the existing egress checks
  (braces). `is_suppressed` blocks all fact writes.
- **Erasure propagation:** §6; ≤72h SLA path unchanged, residual scan extended.
- **Collection posture:** server-side licensed API pull — NOT extension scraping; hard-constraint 4
  untouched (the extension's capture set is unchanged).

---

## 8. HUMAN GATES (nothing below ships/flips without a recorded human decision)

1. **Vendor ToS / DPA / sub-processor review** before any production `LINKEDIN_API_KEY` exists
   (08-compliance §10, 21 §4/§5 — the PDL/Coresignal posture; `provider_configs` compliance status is the
   independently-pausable switch). The vendor-neutral `linkedin_api` label survives a vendor swap; the
   review does not.
2. **Person photo columns** — not shipped (user decision); photos stay raw-only.
3. **pronoun / premium / open_link / job_seeker** ever leaving raw payload.
4. ~~**C6 skills/languages module**~~ — **OPENED 2026-08-16** by explicit user instruction; built as
   `master_person_skills`/`master_person_languages` (0116), landing-wired, DSAR-wired. Volunteering was not
   named and REMAINS gated raw-only; `technology_skill_map` remains the preserved vocabulary idea.
5. ~~**Master-side email/phone contribution from this provider**~~ — **OPENED 2026-08-16** by the same
   instruction ("multiple phone numbers, phone number type and multiple emails and email type"); built as
   the `LINKEDIN_CHANNELS_ENABLED` slice (multi-value, typed, encrypted, claim-pattern converged; facets
   raised TRUE-only). The FLAG still ships off — flipping it in production remains a deliberate act,
   sequenced with gate 1.
6. **Education provenance entity-type** — `provenance_event.entity_type` has `employment` but no
   `education` member; education assertions currently ride the edge table's own provenance columns
   (asserting_source/confidence/source_count). Adding the enum member is a one-line CHECK swap + zod edit
   when field-grain education events are wanted.

---

## 9. Verification (all run 2026-08-16 on local PG17; re-run in full after the same-day amendment)

Amendment coverage on top of the original run: mapper 16 pass (multi-value typed channels — both entry
shapes, case-dedup, primary-first, kind vocabularies; skills case-dedup; language proficiency validation);
`linkedinSourceLanding.itest.ts` 5/5 with the 0116 assertions (2 typed encrypted emails + facets, E.164
phone dedup + line types, skills/languages rows, replay leaves every corroboration counter untouched);
`dsarLayerZero.itest.ts` 10/10 with skills/languages erasure; `masterHeadcount.itest.ts` unchanged 7/9
(same two known-local ACL asserts). Original run detail:

- `packages/types/src/partialDate.test.ts` — 6 pass.
- `packages/core/src/sourceLanding/mapLinkedinPayload.test.ts` — 13 pass (fixtures = the samples; the
  raw-only boundary is asserted, not assumed).
- `packages/integrations/src/enrichment/providers.test.ts` — 22 pass (incl. the 5 new linkedin_api
  contract tests: capabilities honesty, keyless dark short-circuit, path pins, email fallback).
- `packages/db/test/linkedinSourceLanding.itest.ts` — 5/5: person E2E (scalars/identifiers/stints/
  precision/primary/education-school-mint/evidence/events), idempotent replay (no double corroboration),
  pin survives re-land, job-change demote-then-promote + signal, suppressed ⇒ evidence-only, company E2E
  (firmographics/revenue/HQ/series/identifiers) + replay convergence.
- `packages/db/test/masterHeadcount.itest.ts` — 7/9 locally: convergence, stale no-op, derived-growth
  lag() proof, er read path, identifier convergence, backfill agreement, slug LINK. The two 42501
  ACL asserts fail locally with 28P01 — the pre-existing local app-role password mismatch that the shipped
  `masterGraphResolve.itest.ts` shows identically on a clean tree; CI's fresh Postgres asserts them.
- `packages/db/test/dsarLayerZero.itest.ts` — 10 pass (extended: identifiers deleted, self-description
  NULLed, stint prose NULLed, business fact survives).
- Gates: typecheck + typecheck:tests green; lint:boundaries / lint:import-pii / lint:lockfile green;
  `bun run lint` red only on the known repo-wide CRLF issue (code-independent).
- Migrations 0112–0115 apply end-to-end on every itest template build (applyMigrations → grants →
  mirror_partition_acl).

## 10. Enable runbook (when the gates open)

1. Record the vendor review; set `provider_configs` row for `linkedin_api`; issue `LINKEDIN_API_KEY` +
   `LINKEDIN_API_BASE_URL` (staging first).
2. Flip `LINKEDIN_SOURCE_LANDING_ENABLED` (+ `PROVENANCE_EVENTS_ENABLED` if not already on). Watch:
   source_records growth, provenance_event append failures (they fail landings loudly — D7), fold skip
   counts (pins).
3. Flip `LINKEDIN_SIGNALS_ENABLED`; verify job_change rows corroborate `jobChangeSweep` census.
4. Flip `LINKEDIN_COMPANY_REFRESH_ENABLED`; watch the tick log line (due/landed/skipped) and raise
   `MAX_COMPANIES_PER_TICK` only with the spend math updated here.
