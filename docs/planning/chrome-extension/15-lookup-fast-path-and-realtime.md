# 15 — Extension Lookup Fast Path, 30-Day Freshness & Real-Time Infrastructure

**Status: PROPOSED — awaiting operator confirmation (pre-build protocol: no code before the plan is confirmed).**
Date: 2026-08-19 · Outcomes: [S-03][S-10][S-09][S-13][C-01][A-01][C-02]
Builds on: doc 14 (implementation audit), ADR-0043, ADR-0045, ADR-0039 (poll now / SSE later), the
2026-08-18 Layer-0-as-product-database decision (`docs/strategy/decisions.md`),
`docs/planning/extension-intelligence-loop.md`.

---

## 0. The brief, and the one-line verdict

The ask: make the extension lightning-fast on LinkedIn / Sales Navigator person and company pages —
cache-first lookup, a 30-day freshness rule, background enrichment, live updates without page refresh,
batch/multi-profile support, all expensive work async.

**Verdict: ~70% of this architecture already exists in the repo, most of it dark behind flags. The plan
is to close six specific gaps, not to build a new system.** The 30-day rule is already implemented
(`packages/core/src/sourceLanding/fetchAndLand.ts:31`, `FRESHNESS_DAYS = 30`). The cache-first ladder is
already `POST /api/v1/contacts/lookup`. The SSE pipeline is built end-to-end on both sides, dark. The
brief's §3 (network interception) is the one part we must **not** build — see §2.

## 1. Brief → as-built mapping

| Brief section | As-built today | Gap |
|---|---|---|
| §1 Detect LI/SalesNav person+company pages | `adapters/linkedin/index.ts:11-16` detects all five URL shapes; profile + Sales-Nav lead extract; **company/SalesNav-company detected but never extracted** (X07) | Company extraction + company lookup path |
| §2 Identifier extraction | `/in/<slug>` and `sales-lead:<ACwAA…>` subject keys; canonicalized server-side by `linkedinUrlKey.ts` | Sales-Nav company numeric id + company slug |
| §3 Network interception | **Formally rejected** (ADR-0043 §4); ADR-0046 proposes reversing it — status ESCALATE, unresolved legal/ToS risk | Human/counsel decision; not needed for the UX (§2 below) |
| §4 Don't send LinkedIn URLs to the data source | Already centralized: `linkedinUrlKey` → `source_fetch_registry` → `originRouter`/`linkedinSourceClient`; extension only ever sends the page URL/slug | None — keep it that way |
| §5 Cache-first + async enrichment | `POST /contacts/lookup` ladder: workspace overlay → Layer-0 visible person → registry hop → `fetchAndLandUrl` (30-day clock) → re-read | Lookup **blocks** on the vendor fetch; no Redis tier; no SW cache/coalescing |
| §6 Real-time updates | Full SSE pipeline (outbox → relay → Redis pub/sub → `/events/stream`) dark behind `REALTIME_SSE_ENABLED`; extension SSE client built, dark, **discards payloads** | Subject-update topic + payload handling + panel merge |
| §7 `ProfileListPanel` | **Does not exist anywhere in the repo** — vestiges only (`panel.revealAll` i18n key, unread `bulkReveal` flag) | Build it |
| §8 Multi-profile / batch | Sales-Nav harvest (`LINKS_CAPTURED`, 200/batch) registers URLs server-side and renders nothing; web bulk-reveal job is a full reference impl | Batch lookup endpoint + the panel |
| §9 Production-grade | Idempotency, RFC-9457, rate limits, backpressure, job-status patterns all established | Apply them to the new seams |

## 2. Compliance boundary (read first — binding)

The brief's §3 asks the extension to **intercept LinkedIn network activity** to detect profile/company
data. We must not build that. It is:

- **CLAUDE.md Rule 4** (a hard constraint): "never implement, even if asked casually in-session …
  background/bulk scraping of LinkedIn or other logged-in sites; capture of email/message body content …
  Changes here require a human decision recorded in decisions.md."
- **ADR-0043 §4** (Accepted 2026-07-05): "Compliant, user-initiated capture — **reject MAIN-world
  interception**. We do not inject a MAIN-world script or read any site's private APIs." The rejected
  precedent named in the ADR is Apollo, which "monkey-patches `XHR`/`fetch` to harvest LinkedIn's private
  Voyager/Sales-Navigator/Recruiter APIs." Our Apollo teardown of the installed 16.2.2 build confirms it:
  `injectLINetwork.bundle` runs at `document_start` with `host_permissions: ["*://*/*"]` and static
  `web_accessible_resources` — the exact fingerprint LinkedIn's April-2026 "BrowserGate" program probes for.
- **09-compliance §Hard rule 1**: an extension ban "kills the wedge"; ToS/store violations are
  "business-existential." Counsel reviews the capture design.

**The interception is also unnecessary for the UX the brief wants.** Every identifier the brief lists is
already in the URL, which we read without touching the network:

| Page | URL shape | Identifier we already extract (or will) |
|---|---|---|
| Profile | `/in/<slug>` | `publicId` (canonical join key → `contacts.linkedinPublicId`, `masterPersons.linkedinPublicId`) |
| Sales-Nav lead | `/sales/lead/ACwAA…,NAME_SEARCH,fnHM` | `sales-lead:<leadId>` → `salesNavProfileUrl(leadId)` via `linkedinUrlKey.ts` |
| Company | `/company/<slug>` | company slug (X07 — **to build**) |
| Sales-Nav company | `/sales/company/79568557` | numeric company id (X07 — **to build**) |

So: identify from the URL + the rendered, user-visible DOM only; resolve everything server-side. This
delivers the same instant card without the interception liability.

> **Decision required from a human, not this plan (Rule 4 / Rule 6):** whether ADR-0046 (MAIN-world
> Voyager interception, status *Proposed/ESCALATE*) is ever adopted. This plan assumes it is **not**, and
> is fully realizable without it. If it were adopted, it changes nothing below — ADR-0046 firewalls its
> output to Forge (`verified_records` only), never `/api/v1/ingest`, so the lookup fast path is unchanged.

## 3. Target architecture — the fast path

The single structural change is: **the synchronous lookup must never block on a vendor fetch.** Today
`POST /contacts/lookup` awaits `fetchAndLandUrl` inline (`contacts-resolve/routes.ts`), so a cold profile
pays the full vendor round-trip before the card renders. Split it into an instant read and a background
refresh joined by a push.

```
  LinkedIn / Sales Nav page
        │  (content script: URL + visible DOM only — no network interception)
        ▼
  subjectKey  ──send()──►  Service worker (the only privileged context)
        │                        │  1. SW cache hit? (memory + IDB, short TTL, single-flight)  ── yes ─► render instantly
        │                        ▼  no
        │                  POST /api/v1/contacts/lookup   (SYNCHRONOUS, never blocks on a vendor)
        │                        │
        │                        ▼
        │      ┌─────────────────────────────────────────────────────────────┐
        │      │  Redis read-through (apps/api/src/cache.ts, gen-keyed, ~30s) │  ── hit ─► return
        │      │        │ miss                                                │
        │      │        ▼                                                     │
        │      │  L1 workspace overlay   (contactRepository.findByDedupKeys)  │
        │      │        │ miss                                                │
        │      │        ▼                                                     │
        │      │  L2 Layer-0 master graph (masterPersonReadRepository,        │
        │      │        MASTER_PERSON_VISIBLE) + registry hop                 │
        │      └─────────────────────────────────────────────────────────────┘
        │                        │
        │            compute freshness verdict from source_fetch_registry.last_fetched_at
        │                        │
        │       ┌────────────────┴─────────────────────────────┐
        │       ▼                                              ▼
        │   fresh (<30d) or found                       missing OR stale (>30d)
        │       │                                              │
        │   return {status, data, freshness:"fresh"}    return {status, data?, freshness:"stale"|"absent",
        │                                                        refresh:"queued"}  +  ENQUEUE background fetch
        │                                                        (linkedin_link_fetch queue, jobId = norm URL)
        ▼                                                        │
  render immediately                                            ▼  worker: fetchAndLandUrl → land → provenance
        ▲                                                        │           → append outbox event (same tx)
        │                                                        ▼
        │                                              relay → Redis pub/sub rt:ws:<wid>
        │                                                        ▼
        └────────── SUBJECT_STATUS broadcast ◄── SW SSE client ◄── GET /api/v1/events/stream
                    (panel/hovercard merges the row — no page refresh)
```

Everything on the "fresh/found" branch is a read the extension already makes; the change is (a) a Redis
tier in front of it, (b) replacing the inline `await fetchAndLandUrl` with an enqueue, and (c) wiring the
already-built SSE client to actually apply the pushed payload.

## 4. The six gaps, and how each closes

Each gap names the exact seam. None invents a new subsystem.

### Gap 1 — Non-blocking lookup (the core change) · [S-03][C-01]

**Change** `POST /api/v1/contacts/lookup` (`apps/api/src/features/contacts-resolve/routes.ts`) so the
vendor fetch is an enqueue, not an inline await:

1. Canonicalize `linkedinUrlKey(...)` (unchanged).
2. Read workspace overlay → Layer-0 visible person → registry hop (unchanged, all fast DB reads).
3. Compute a **freshness verdict** from `source_fetch_registry.last_fetched_at` vs `FRESHNESS_DAYS = 30`
   (`sourceFetchRegistryRepository.isFresh` already exists).
4. Return **immediately** with `{ status, data?, freshness: "fresh" | "stale" | "absent", refresh:
   "queued" | "none" }`. Never call `fetchAndLandUrl` on the request path.
5. When `freshness ∈ {stale, absent}` and `LINKEDIN_SOURCE_LANDING_ENABLED`, enqueue a background fetch on
   the existing `linkedin_link_fetch` queue with a **deterministic `jobId` = the normalized URL**, so
   concurrent viewers of the same profile coalesce to one vendor call (dedupe idiom already in the repo —
   `deduplication:{id}` clears on completion, the right choice here).

Response shape lives in `@leadwolf/types` (shared with the SW client) and adds `refresh` + `freshness`
without breaking the existing `found | in_database | not_found | unavailable | not_supported` union.

### Gap 2 — Redis cache tier + SW cache + request coalescing · [S-03]

**Server:** wrap steps 2–3 in the read-through pattern (`apps/api/src/cache.ts` fail-fast client +
generation key, exactly like `apps/api/src/features/search/searchReadCache.ts`). Key =
`tenantKey({tenantId, workspaceId}, "extlookup", "g<gen>", normalizedUrl)`, TTL ~30 s with jitter.
Invalidate by DEL-ing the key (or bumping the workspace generation) **inside the landing transaction** so a
just-enriched profile shows fresh on the next lookup. Fail-open: a wedged Redis falls through to Postgres.

**Service worker:** today there is *no* coalescing — every SPA nav/settle re-fires `LOOKUP`. Add:
- A memory `Map<subjectKey, {result, at}>` in the SW with a short TTL (≈60 s) for the warm case.
- A single-flight `Map<subjectKey, Promise>` so rapid re-entry to the same profile awaits one request.
- Persist the last result to the IDB `recent` store **and finally enforce the `expiresAt` TTL** — today
  `expiresAt = now + 24h` is written but no reaper reads it (`scheduler.ts:68` vs `Panel.tsx:99`); rows
  accumulate forever. Add a reaper on the existing `flush` alarm.

Because the SW dies ~30 s after its last event, memory is a warm-path optimization only; IDB is the
source of truth across wakes (state-and-storage tiers, architecture skill).

### Gap 3 — Company path (person parity) · [S-09][S-13]

**Content script** (`adapters/linkedin/index.ts`): company pages are already *detected* but `extract()`
returns `null` (X07). Add a company extractor that emits the identifier from the URL — `/company/<slug>`
and `/sales/company/<numericId>` — plus minimal visible fields, and set the page type so
`content/index.ts` shows a company card. Keep the two extractors separate (Sales-Nav markup shares nothing
with the public page — the existing profile/lead split proves this).

**Server:** the company resolution ladder already exists —
`masterGraphRepository.resolveCompany` (`primary_domain` → `linkedin_company_id` →
`linkedin_company_slug`) and `linkedin_company_refresh` queue. Add a company branch to `/contacts/lookup`
(or a sibling `/accounts/lookup`) reusing that ladder + the same 30-day registry clock.

### Gap 4 — Light up the real-time subject-update topic · [S-10][S-13]

The SSE pipeline is fully built and dark. The extension's SSE client (`background/eventStream.ts`) already
streams `/events/stream` with a manual frame parser (MV3 has no `EventSource`) — but it **parses the
payload and discards it**, only re-broadcasting `STATE_CHANGED`. Close the loop:

1. Define a PII-free event `EVENT_CONTACT_LOOKUP_UPDATED { workspaceId, subjectKey }` in
   `packages/types/src/realtimeEvents.ts` (mirror the existing `EVENT_NOTIFICATION_CREATED` — payload is
   ids only, never fields; contributor identity never leaves the DB — Invariant 2 / C-02).
2. **Producer:** append the outbox row **in the same transaction as the landing** (`landSourcePayload.ts`
   / `fetchAndLand.ts`), behind `REALTIME_SSE_ENABLED`. The relay → Redis `rt:ws:<wid>` → hub → stream is
   unchanged.
3. **Consumer:** in `eventStream.ts`, on that event emit a `SUBJECT_STATUS` broadcast; the panel/hovercard
   re-reads (or the payload carries the new status) and **merges the one row**.
4. **Keep poll as the safety net** (ADR-0039 stance, and the shipped web pattern: poll is the source of
   truth, SSE demotes it to a backstop). Concretely: the panel must **hydrate on open** — today `RevealTab`
   is purely push-driven and `CapturedTab` is one-shot-on-mount and never re-reads. A refresh landing while
   the panel is open must appear via either the push or a low-frequency backstop refetch, never require a
   reopen.

### Gap 5 — Batch lookup endpoint + server-side dedup · [C-01]

Add `POST /api/v1/contacts/lookup:batch` (add it to the `extensionScope.ts` allowlist, method-aware, or it
403s at enforcement flip). It accepts ≤ N identifiers, **dedupes them server-side**, runs each through the
same ladder (reusing `contactRepository.findByDedupKeysBatch` and the batch master-resolve), and returns a
per-identifier result array. Enqueues **one** background fetch per stale/absent identifier (deterministic
jobId dedupe still applies). Metered by `rl:capture` (record-count aware, 2000/min) rather than the
per-request `rl:api:sub`. This powers both the multi-profile panel (§7) and the existing Sales-Nav harvest
(`LINKS_CAPTURED`) which today registers URLs and renders nothing.

### Gap 6 — Build `ProfileListPanel` (the multi-profile screen) · [S-03][C-01]

It does not exist. Build it as a new tab in the side panel, reusing the established extension UI
conventions (inline-styled `var(--tp-*)` tokens, the four-state pattern, `send()` + `onBroadcast`, no new
state library):

- **Feed:** on a Sales-Nav search/list page, the content script already harvests up to 200 anchor hrefs per
  batch (`harvestLinks` + `LINKS_CAPTURED`). Route those through the batch lookup (§5) and render a row per
  subject.
- **Per-row state machine:** each row owns its own `resolving | known | owned | unknown | stale |
  revealing | error` state, its own freshness pill, its own primary action — independent loading/enrichment
  status, per the brief §8.
- **Live per-row updates:** merge `SUBJECT_STATUS` pushes by subjectKey (today it replaces the whole tab;
  it must merge one row).
- **Reveal-all:** wire the orphaned `panel.revealAll` i18n key and the unread `bulkReveal` flag. Reuse the
  web bulk-reveal job wholesale — `apps/web/src/features/prospect/{useBulkReveal,BulkRevealDialog,
  BulkActionBar,BulkRevealJobDialog}` + `apps/api/src/features/reveal/bulkRevealQueue.ts` — including the
  `>25 → async job` threshold and the confirm-before-spend money gate. Do not build a second reveal path.

## 5. The brief's scenarios, mapped to real code

**Scenario A — data exists and is fresh (<30d).** Steps 1–4 of Gap 1: SW cache or Redis or workspace/Layer-0
read returns `{status: found, freshness: fresh}`. No vendor call. Card renders from cache. This is the
common case once seed data is loaded.

**Scenario B — data does not exist.** Ladder misses at every tier → return `{status: not_found,
freshness: absent, refresh: queued}` **immediately** with the minimal page-visible fields the content
script already extracted, and emit a `reveal_miss` usage event (already wired in `by-linkedin`, HMAC
fingerprint, never the slug — this is "most-wanted feed" fuel, 08 §confidence). Background fetch lands →
outbox event → SSE → row fills in. No page refresh.

**Scenario C — data older than 30 days.** Ladder hits but `last_fetched_at > 30d` → return the existing
(stale) data instantly with `freshness: stale, refresh: queued`, enqueue the refresh, push the delta when
it lands. `landSourcePayload` already supersedes rather than overwrites (`parser_version`-tagged) and the
`field_provenance` fold blocks clobbering a human-pinned field — so "compare old vs new, update" is the
survivorship projector's existing job, not new code.

## 6. The 30-day freshness rule — one subtlety that must not be conflated

There are **two** different clocks, and the plan uses each deliberately:

1. **The fetch/refresh clock (the brief's "30-day rule"):**
   `source_fetch_registry.last_fetched_at` + `FRESHNESS_DAYS = 30` (`fetchAndLand.ts:31`). This decides
   **whether to call the vendor**. Written only by `recordFetch`, on every attempt. This is the clock Gap 1
   reads.
2. **The display-freshness badge (S-10):** `contacts.last_verified_at` → `dataHealth.freshnessStatus` with
   per-field SLAs (`FRESHNESS_SLA_DAYS = {email:90, phone:180, employment:60, firmographics:180}` in
   `packages/types/src/dataHealth.ts`). This is what the card *shows* the user ("verified n days ago").

Do not drive the refresh decision off `last_verified_at`, and do not show the raw `last_fetched_at` as the
badge. The masked contact DTO already carries `lastVerifiedAt` + `dataHealth` for free
(`contactRepository.ts`), so the card's badge needs no extra query. The richer corroboration half of the
badge (`provenanceBadgeRepository.badgeFor`, "k independent sources") is **dark in prod**
(`PROVENANCE_EVENTS_ENABLED` default-off) — copy the `revealContact.ts` fallback exactly: show
`lastVerifiedAt` + `dataHealth` now, and light up source-count only when the flag and `masterPersonId` are
both present.

## 7. Multi-profile handling (brief §8) — the specifics

| Requirement | Mechanism |
|---|---|
| Multiple profiles on one page | Sales-Nav `harvestLinks` (already batches 200/nav-key with a `Set` dedupe) |
| Batch backend lookups | `POST /contacts/lookup:batch` (Gap 5) |
| Deduplicated requests | server-side dedupe in batch + deterministic `jobId` per URL for fetches + SW single-flight |
| Parallel processing | one background fetch job per stale subject; worker concurrency already bounded |
| Individual loading / enrichment status | per-row state machine (Gap 6) |
| Real-time per prospect | `SUBJECT_STATUS` merged by subjectKey (Gap 4) |
| Efficient caching | Redis tier + SW cache (Gap 2) |
| Duplicate-request protection | idempotency-key on writes; registry unique `(entity_kind, normalized_url)`; capture idempotency = `hash(sourceUrl + fields)` |
| Stays responsive under many profiles | reads are cheap + cached; the expensive vendor work is queued and backpressured (`MAX_WAITING_*` shed-at-the-door) |

## 8. Reasoning pass (pre-build protocol — the load-bearing answers)

- **Source of truth.** Workspace overlay for owned contacts; Layer-0 master graph for the licensed
  database; `source_fetch_registry.last_fetched_at` for "when did we last fetch." SW caches and the panel
  are views, never owners. On conflict, the DB row + its `field_provenance`/survivorship fold wins.
- **Failure modes.** Vendor down → `originRouter` backoff; lookup still returns cached/absent instantly
  (never blocks). Redis down → fail-open to Postgres. SSE drop → silent fallback to alarm/poll. SW killed
  mid-fetch → the fetch is a durable queue job, re-drained on the next alarm; ingest is a server-side
  no-op on replay. Enrichment write must fail the whole landing if the provenance event append fails (D7 —
  a fact must not survive without its assertion).
- **Duplicate prevention.** Deterministic `jobId` = normalized URL; registry `(entity_kind, normalized_url)`
  unique; per-workspace partial-unique on `linkedinPublicId`/`salesNavLeadId`; idempotency-key on reveal /
  add-to-workspace.
- **Security / tenancy.** Every read is tenant-scoped by RLS; `MASTER_PERSON_VISIBLE` (visibility ∈
  {licensed,coop} ∧ ¬suppressed ∧ ¬merged) is applied inside every Layer-0 read; suppression enforced at
  every egress including reveal. The SW is the only credential holder; no token ever reaches a content
  script or page. Tenancy comes from verified token claims, never a request body. New routes must be added
  to `extensionScope.ts` (deny-by-default).
- **Scalability.** The hot path is now cached DB reads (Redis L2 + SW L1), not vendor calls. Batch lookup +
  per-URL fetch dedupe collapse a Sales-Nav page of 25 profiles into one fetch per *unseen* subject.
  Backpressure sheds at the door with typed 503s. **Gap:** there is no per-tenant rate bucket above the
  per-subject `rl:api:sub` (300/min) — a large tenant can fan out to `300 × N users`. Flag for platform if
  tenant-level fairness on lookup matters at launch scale.
- **Observability.** Reuse the `tracedWorker` + structured-error posture; add a lookup-cache-hit-rate
  metric and a "background fetches enqueued vs landed" counter so we can see the fast path working. SSE
  connection cap is per-process (`5 × N instances`) — a resource guard, not a quota.
- **Rollback.** Every piece is flag-gated: `CHROME_EXTENSION_ENABLED`, `EXTENSION_ORIGINS`,
  `LINKEDIN_SOURCE_LANDING_ENABLED`, `REALTIME_SSE_ENABLED`, `bulkReveal`. The panel ships behind the flag;
  the non-blocking lookup degrades to "return what we have" if landing is off. No migration is destructive
  (the new event topic and cache keys add, never alter).
- **Worst case.** A runaway enrichment loop (the brief's own fear). Prevented by: deterministic-jobId
  dedupe, the 30-day registry clock (a fresh subject never re-fetches), per-tenant provider budget
  (`enrichment_policy` budget micros + circuit breaker), and charge-only-on-verified billing. The
  extension is a thin producer — it holds no provider keys and cannot call a vendor directly.

## 9. Compliance impact (CLAUDE.md Rule 3 / 09-compliance review gate)

- **Data elements touched:** work identity (name, title, company, location — user-visible), work email /
  phone (revealed on explicit action, credit-metered), LinkedIn public id / Sales-Nav lead & company ids
  (addressing keys). No sensitive categories; no personal addresses; **no message/body content ever**.
- **Lawful-basis tag:** capture arrives `acceptance_state='pending'` unless a basis is declared, and
  pending rows **do not project** (D6). Licensed Layer-0 rows carry `source_name` and `visibility`.
- **Consent surface:** capture attaches `consent` + `sourceUrl` + `capturedAt`; user-initiated only.
- **Suppression enforcement point:** at read (`MASTER_PERSON_VISIBLE`, `is_suppressed`) and at every
  egress (reveal/search/export/sync) — one list, enforced everywhere.
- **Erasure propagation:** tombstone provenance event → graph reprocess → suppression at egress (A-02,
  ≤72h SLA). Unchanged by this plan.
- **Gates stay off until counsel sign-off** (D10/D12): building is allowed; *enabling* is a counsel
  decision. This plan ships everything dark.

## 10. Phased build (each phase independently shippable, dark)

| Phase | Scope | Primary files | Outcome |
|---|---|---|---|
| **P0** | Non-blocking lookup: split the inline `fetchAndLandUrl` into enqueue + instant return; add `freshness`/`refresh` to the response type | `contacts-resolve/routes.ts`, `@leadwolf/types`, `linkedinLinkFetchSweep`/`linkedin_link_fetch` enqueue | S-03 (instant card) |
| **P1** | Redis lookup cache + SW memory/IDB cache + single-flight + `recent` TTL reaper | `apps/api/src/cache.ts`, `searchReadCache`-style key; `background/*`, `shared/idb.ts`, `events/manager.ts` | S-03 (warm path) |
| **P2** | Real-time subject-update topic: new event, outbox producer in landing tx, wire the dark SSE client's payload → `SUBJECT_STATUS`; panel hydrate-on-open | `realtimeEvents.ts`, `landSourcePayload.ts`, `eventStream.ts`, `Panel.tsx` | S-10/S-13 (live update) |
| **P3** | Company path: company extractor + company lookup branch reusing `resolveCompany` + `linkedin_company_refresh` | `adapters/linkedin/*`, `content/index.ts`, `contacts-resolve`/`accounts` route | S-09/S-13 |
| **P4** | Batch lookup endpoint + server dedup; add to `extensionScope` allowlist | `contacts-resolve/routes.ts`, `extensionScope.ts`, `contactRepository.findByDedupKeysBatch` | C-01 |
| **P5** | `ProfileListPanel` + reveal-all reusing the web bulk-reveal job | `apps/extension/src/ui/panel/*`, i18n `revealAll`, `bulkReveal` flag | S-03/C-01 |

## 11. Risk flags (need a decision or have no clean answer yet)

1. **ADR-0046 (network interception)** — a standing human/counsel decision; this plan does not depend on
   it and recommends leaving it *Proposed*. (Rule 4)
2. **Enablement gates** (`CHROME_EXTENSION_ENABLED`, `EXTENSION_ORIGINS`) stay off pending counsel review
   of the capture design (D12) — a product/legal gate, not an engineering one.
3. **No per-tenant rate bucket** above `rl:api:sub` — decide with platform whether launch scale needs one
   for lookup fan-out.
4. **Provenance corroboration half is dark** (`PROVENANCE_EVENTS_ENABLED` off) — the S-10 badge shows
   recency+health now, source-count later; confirm that's acceptable for the first cut.
5. **Layer-0 master-graph MatchPort tier-2 is a hard stub** (billions-scale candidate index staged
   M12/M13) — the extension's single-record lookup uses the deterministic key ladder, which is real today;
   the fuzzy fallback is not. Fine for URL-keyed lookup; note it.

## 12. What this plan is NOT doing

- Not building or enabling MAIN-world network interception (Rule 4 / ADR-0043 §4).
- Not turning any gate on — everything ships dark; enablement is a separate, counsel-gated step.
- Not building a second reveal or billing path — reuse the shipped credit money loop and bulk-reveal job.
- Not building CSV/bulk-file enrichment (M17 flagship) — out of scope for the extension fast path.
- Not adding a WebSocket — SSE is the chosen transport and is already built.
- Not caching absence in a way that hides a newly-added record (role-cache lesson: never cache `null` past
  a short TTL; invalidate on landing).
```
