# 02 — Root-Cause & Gap Analysis

> **Status of this doc:** complete (analysis doc — built entirely on
> [`01-Current-State-Audit.md`](01-Current-State-Audit.md) for evidence and
> [`03-Enterprise-Research.md`](03-Enterprise-Research.md) for external practice; verified at the
> same head as doc 01, branch `feat/data-mgmt-01-research-brief`).
> **What this doc owns:** the five root causes (RC-1…RC-5) behind the two reported problems, and
> the series-wide **gap register** (G01…G26) that every design doc (`04`–`15`) cites. Gap IDs are
> the shared namespace of this series; no design doc may invent its own.
> **What this doc does not do:** restate the as-is (that is doc 01) or design fixes (docs 04–15).

---

## Objective

Explain **why** the import system reads as broken and why the data model can no longer carry the
product — as five root causes, each traced from observed defect → code mechanism → the design
history that produced it → the consequence of leaving it alone. Then formalize every discrete
deficiency as a numbered gap with severity, root-cause linkage, evidence (doc 01 section),
enterprise-practice anchor (doc 03 section), and the design doc that owns its fix.

Two reported problems drive this series (README §Why):

1. **"Imports are broken/untrustworthy"** — including one confirmed defect class: queued import
   jobs visible to every user in a workspace.
2. **"Import UX is poor"** — entry points, mapping, progress, and error handling all below the
   enterprise bar.

Doc 01's verdict is the essential framing: **the sync happy path is functionally sound**
(middleware, idempotency, RFC 9457, backpressure, DLQ — 01 §2.1) — so "broken" is not one bug.
It is the compound of five structural causes below.

---

## Current Challenges (summary; the full as-is is doc 01)

- Two disjoint import systems: a live sync path whose only job state is Redis, and a dark bulk
  path with the durable `import_jobs` trio (01 §2).
- Every job-list surface in the customer app is workspace-scoped only — creator columns exist,
  populated, and unread (01 §5).
- The wizard actively recommends a path that 403s, polling gives up at ~2 minutes, and there is
  no imports page to check back on (01 §4).
- Contacts hold exactly one email and one phone; accounts have one domain, no hierarchy, no
  locations, no soft-delete; nothing in the product ever merges records — it only marks them
  (01 §6).

---

## Part 1 — Root causes

### RC-1 · Job-visibility leak: workspace-only RLS with no owner or capability predicate

**Defect as observed.** Any member of a workspace sees every other member's import activity
(home Recent Imports card), every reveal job, and every enrichment job — the reported
"queued import jobs are visible to every user" defect class, confirmed live on three surfaces
plus one dark one (01 §5.7 matrix).

**Mechanism.** Visibility everywhere is the tenant wall and nothing else:

- RLS on the durable import trio scopes on `workspace_id` alone —
  `import_jobs_workspace_isolation` policy (`packages/db/src/rls/importJobs.sql:11–13`, quoted in
  01 §5.1). Same shape for rows and chunks.
- `created_by_user_id` **exists and is populated on create** (`schema/importJobs.ts:45`,
  `bulkRoutes.ts:190`) but appears in **no predicate anywhere** — repo-wide (01 §5.2). The same
  pattern holds for `source_imports.imported_by_user_id` (01 §4.4) and the live reveal and
  enrichment list queries (01 §5.3–5.4).
- The only role gate is `requireRole("owner","admin","member","viewer")` — i.e., workspace
  membership; a **viewer** sees every member's jobs (01 §5.3).
- RLS structurally cannot carry the fix: `withTenantTx` sets only `app.current_tenant_id` and
  `app.current_workspace_id` — **there is no user GUC**, so "owner or admin" is inexpressible in
  policy today (`packages/db/src/client.ts:82–91`, 01 §5.1).

**Why it came to be.** This is inherited posture, not an oversight in one route. The overlay's
ownership model is *deliberately* filter-only — `contacts.owner_user_id` is documented as "a
filter dimension, never a per-row access wall … Visibility stays workspace-wide via RLS"
(01 §6.4), and DM4 locks tenancy as the two-tier tenant/workspace wall
(`../data-management/00-overview.md` §DM4). Job tables copied the contacts RLS idiom verbatim;
job *lists* were then built as thin read-models over that idiom (reveal and enrichment lists,
01 §5.3–5.4), and each new surface — including the home card — mirrored the last. The capability
system that *could* have gated reads was built for Surface 1 only (staff
`data:read/manage/review/export`, correctly locked — 01 §5.6) and must never gate `apps/web`
(README two-surface note). Records being workspace-visible is a product decision; **job records
silently inheriting it was never decided** — no prior series ever examined job-object visibility.

**Consequence if unaddressed.** Every new job surface leaks by default (the pattern has already
propagated to three live surfaces); enterprise buyers evaluate exactly this rule — HubSpot's
export-log split (members see own, super-admins see all) and Salesforce's creator-or-permission
abort rule are documented product contracts (03 §5.1 [7][56]). And the fix locus is fixed by the
mechanism: **an app-layer owner/role predicate in repository signatures** (03 §5.2; design in
doc 10), because no user GUC exists and product policy does not belong in RLS (program decision
3 applies it uniformly to import + reveal + enrichment + Recent Imports).

---

### RC-2 · Dual-pipeline split: the live path has no durable state; the durable path is dark

**Defect as observed.** Imports "vanish": a completed import returns 404 the next day; there is
no history, no cancel, no retry, no completion notification — while a fully built durable
pipeline sits dark behind two flags.

**Mechanism.** Two systems share parse/validate/prepare and nothing else (01 §2 table):

- **Sync (live):** job state lives *only* in BullMQ/Redis, `removeOnComplete: {age: 24h,
  count: 1000}` (`queue.ts:31`); rows travel in the job payload; the router exposes only
  `POST /`, `POST /preview`, `GET /:jobId` — **no list endpoint** (01 §2.1). After Redis
  eviction, `GET /imports/:jobId` 404s "indistinguishable from a job that never existed"
  (01 §4.3). History, cancel, retry, and notifications are **unimplementable on this path
  as-is** — there is no durable row to list, no state machine to transition to `cancelled`,
  and nothing to attach an outbox event to.
- **Bulk (dark):** the durable trio `import_jobs`/`_chunks`/`_rows` with a 9-state CHECK-enforced
  machine, row accounting, reject histogram, resume watermark (01 §2.2) — everything the sync
  path lacks — gated by `BULK_IMPORT_ENABLED` (router 403s; worker never constructed,
  `register.ts:848`) **and** the per-tenant flag.
- Neither path uses the shipped transactional outbox: sync enqueues directly, bulk finalize
  fires rollups best-effort from the chunk processor (01 §7.1).
- Even the bulk path exposes **no cancel endpoint** — the state exists in the enum; no route
  drives it (01 §2.2 route inventory: POST + GET only).

**Why it came to be.** Deliberate sequencing, not accident. The bulk pipeline was designed and
built **ahead of its enable gates as gated dead code** per the standing go-ahead — the
design-of-record says so explicitly: the COPY spike "is now an ENABLE-gate, not a build-gate,"
and everything shipped "ADDITIVE + dark by default"
(`../data-management/15-bulk-import-design.md` §6). The three gates (production object store, AV
scan, COPY-FROM-STDIN proof — 01 §3) could not be cleared in the build sandbox, so the flag
stayed off everywhere. The sync path, meanwhile, predates the trio and was kept minimal — the
trio was introduced *for* bulk (mirroring the `enrichment_jobs` idiom, 01 §7.4) and was never
retrofitted under the live path. The queue vendors themselves document queue-native state as
ephemeral by design (03 §6.1 [138][142]); using it as the *only* job record was an MVP economy
that was always meant to be temporary and then wasn't.

**Consequence if unaddressed.** The product's only *live* import experience permanently lacks the
market-mandatory durable job contract (states, counters, results artifacts, indefinite pollability
— Salesforce Bulk 2.0 / HubSpot Imports, 03 §6.1–6.2 [57][18]); every UX fix in doc 11 hits the
same wall (nothing durable to render); and the two systems drift further apart with every change
made twice or made once on the wrong path. The unification (all imports on the trio; server picks
the path; small files = priority lane — doc 08) only gets more expensive.

---

### RC-3 · Perceived-breakage chain: dead-end toggle → 403; poll timeout → silent abandonment; nowhere to check back

**Defect as observed.** Users report "imports not working correctly" against a sync path that doc
01 verifies as functionally sound (01 §2.1). The breakage is *perceived* — manufactured by three
compounding UX behaviors.

**Mechanism** (each verified, 01 §4):

1. The wizard unconditionally renders a "Large file — import in the background **(recommended
   for big uploads)**" toggle (`ImportWizard.tsx:305–313`) while bulk is dark in every
   environment; submitting hits the layer-1 403 and the error tells the user to undo their
   choice (01 §4.1). The UI recommends a guaranteed failure.
2. The status poll gives up: 1.5 s × 80 ≈ 2 minutes, then "Import is taking longer than expected.
   Check back shortly." (`useImport.ts:30–31,79–83`) — with **nowhere to check back**: no list
   endpoint, no imports page, and navigating away destroys the in-memory `jobId` (01 §4.2). A
   legal 3-minute CSV is indistinguishable from a dead one.
3. Even a successful import evaporates within 24 h (RC-2), so retrospective confidence
   ("did Tuesday's import run?") is impossible (01 §4.3).

A fourth finding hardens the chain: `BULK_IMPORT_THRESHOLD_ROWS` is **dead config** — defined,
documented as "consumed by the promotion logic," consumed nowhere (01 §4.1, correction 4). There
is no server-side sync→bulk promotion; routing is a manual client checkbox.

**Why it came to be.** Each link was individually reasonable. The toggle shipped with the wizard
while bulk was expected to enable shortly (the data-management/15 phases were "safe → gated");
the UI was built dark-ready — the bulk 403 even renders a *distinct* disabled state on the job
page (01 §2.2 hop 13) — but the wizard's entry point was left visible. The ×80 poll cap was a
guard against infinite polling given that no durable record existed to poll indefinitely
(RC-2 dependency). No "my imports" page exists because no list endpoint exists (RC-2 again;
`listJobsByWorkspace` sits unrouted — 01 §5.2). The chain is RC-2's UX shadow plus one rollout
oversight.

**Consequence if unaddressed.** Trust damage compounds: every user who flips the recommended
toggle experiences a hard failure; every slow import ends in a shrug; every "did it work?"
question is unanswerable. Enterprise platforms treat durable, navigable import history with
per-job completion accounting as table stakes (03 §1.1 [4][5], §5.1 [6][54]); polling is indefinite
against durable counters, never a give-up (03 §6.3 [56][129]). Until RC-2/RC-3 land together
(docs 08 + 11), "imports are broken" remains true *as experienced* regardless of pipeline
correctness.

---

### RC-4 · Single-channel schema: the product outgrew the Layer-0-only multi-value model

**Defect as observed.** A contact can hold exactly one email and one phone; an account exactly
one domain, no parent, no locations. Sales-intelligence workflows (mobile + direct-dial + HQ
line; personal + work email; multi-domain companies) cannot be represented at all.

**Mechanism.** The overlay carries single flat encrypted columns — `email_enc`/`email_blind_index`
/`email_domain`/`email_status`, `phone_enc`/`phone_status`/`phone_line_type`
(`contacts.ts:120–136`, 01 §6.2). Multi-value channel tables exist **only** in Layer-0
(`master_emails`/`master_phones`) and — verified stronger than prior briefs — they hold **no
revealable values today**: the import resolve stores blind index + domain with `email_enc = NULL`,
phone resolution is deferred outright, and **no application code joins these tables into any read
path** (01 §6.2, corrections 2). Same shape for companies: hierarchy and multi-domain live only
on `master_companies` (`parent_company_id`, `alt_domains[]`), never surfaced to `accounts`
(01 §6.5). Employment history: Layer-0 SCD2 only; the overlay is a flat `account_id` +
denormalized title (01 §6.6).

**Why it came to be.** The architecture placed multi-value channels on the master graph by
design: ADR-0021 / `docs/planning/03-database-design.md` §5.1 model channels as verifiable
objects of the *global* graph (`master_emails` as "verifiable channel, separated from the person
record"), while the overlay stayed deliberately flat — one encrypted value + blind index is what
the RLS wall, per-workspace dedup uniques, search facets, and the COPY-staging encoder were all
built against (01 §6.2–6.3). The piece that would have carried master richness to tenants — the
survivorship **projection** over `source_records` with its `projection_outbox` and projector
worker (`../prospect-database-platform/05-Internal-Knowledge-Database.md` §4.1) — **never
shipped** (its build checklist is unchecked). And critically, even if it had: a projection is
read-only intelligence; it cannot serve *workspace-local* needs — a rep adding a second phone,
pinning it, or marking it bad is an overlay write the master graph must never absorb directly
(DM4; the README pins prospect-database-platform/05 as the future *feeder* of overlay channel
tables, not their replacement).

**Consequence if unaddressed.** Head-to-head feature loss against every surveyed platform —
Salesforce runs child ContactPoint objects alongside the flat cache, HubSpot runs primary +
computed overflow (03 §3.1–3.2 [41][44][10]); imports of multi-phone datasets silently drop
values; enrichment has nowhere to put a second verified channel, so paid data is discarded; and
RC-5 stays unsolvable, because type-aware merge (losing email → secondary) is only possible once
child value rows exist (03 §2.3 [9]). Docs 04/05/06 own the fix: overlay child tables
`contact_phones`/`contact_emails`/`account_domains` with the flat columns retained as the
primary-value cache — the industry-proven dual shape (03 §3.3).

---

### RC-5 · Marker-only dedup/merge: nothing ever merges, and child tables will make it worse

**Defect as observed.** Duplicates are detected and marked but never resolved; the one "merge"
executor annotates without moving a single value; duplicate markers accumulate with no review
surface.

**Mechanism** (01 §6.9): the automated sweep "never merges or deletes rows" — it only sets
`contacts.duplicate_of_contact_id`. Admin grain-A `execDedupMerge` is maker-checker'd and
tenant-scoped, and — verified precisely — writes **the same marker, nothing else**: no field
union, no re-pointing of children (activities, list members, reveals), no master-graph write
("grain B remains security-review-gated", `platformAdminWrites.ts:337`). Grain-B is design-only.
There is **no true merge** (field union + child re-pointing + loser tombstone) anywhere. Two
structural blockers compound it: accounts have no `deleted_at`, so a merge loser cannot tombstone
(01 §6.5); and single-value channels mean a losing record's email/phone would be *discarded*
rather than demoted to a secondary value (RC-4 dependency).

**Why it came to be.** Deliberate, layered caution. The automated layer was scoped conservative
by design (suggestion-only markers). The grain-A executor was shipped overlay-only and
marker-only *explicitly pending security review* of grain-B master-cluster merge — the code
comment is the decision record. Prior series kept the deferral: prospect-database-platform
defers the merge/split executor pending security review, and I5's probabilistic ER proposes
`match_links` only, shadow-gated (01 §6.9). Nobody decided merge should not exist; everybody
correctly declined to ship a destructive, irreversible operation before its prerequisites
(tombstones, child re-pointing semantics, review UX) existed. Enterprise practice vindicates the
caution — merge is irreversible everywhere ("unmerge exists nowhere", 03 §2.1 [9][40][87]) — but
not the standstill.

**Consequence if unaddressed.** Duplicate debt compounds unresolvably — markers pile up with no
queue to work them (03 §2.1, §2.3: persistent review queues are the market pattern [34][8]). Worse,
the RC-4 fix actively **raises the stakes**: once `contact_phones`/`contact_emails` (and
`account_domains`) exist, every contact has child rows, so a marker-only "merge" leaves N tables
of orphan-prone children instead of one flat row — and the shipped grain-A executor, which does
not re-point children today, becomes *more* wrong with every child table added. Merge execution
(Salesforce mechanics: re-point children → survivor keeps ID → soft-delete loser, 03 §2.3 [40])
must be designed in doc 04 with docs 05/06 as prerequisites, and sequenced in doc 14 *after* the
channel tables land.

---

### How the root causes interact

```
RC-2 (no durable state) ──produces──▶ RC-3 (perceived breakage)
        │                                   ▲
        └── gates (G07–G09) keep the        │ dead-end toggle is the
            durable path dark ──────────────┘ visible symptom
RC-1 (visibility) — independent defect, same fix locus as job lists (doc 10 rides doc 08's endpoints)
RC-4 (single-channel) ──prerequisite-for──▶ RC-5 (merge) — and RC-5 worsens if RC-4 ships without it
```

Order of operations for the roadmap (doc 14): RC-2+RC-3 together (08/09/11), RC-1 on the same
endpoints (10), RC-4 (04/05/06) before RC-5's merge executor (04 §merge).

---

## Part 2 — Gap register

The shared namespace of this series. Every design doc (`04`–`15`) cites gaps by **G-number**;
the *Alias* column preserves the program brief's working IDs so nothing is lost.

**Severity:** **P0** = a reported-defect class, or a hard blocker on the redesign's rollout ·
**P1** = an enterprise-parity gap that shapes the target design · **P2** = quality/scale/deferred.
**Adjacent-scope** (marked ◇) = confirmed real, but the roadmap (doc 14) defers it beyond this
series' core phases; the owning doc records the design intent only.

### Register

| Gap | Alias | Title | Sev | RC | Evidence (01) | Enterprise practice (03) | Owning doc |
|---|---|---|---|---|---|---|---|
| **G01** | G-B1 | Job visibility is workspace-wide: no owner predicate or role gate on import/reveal/enrichment job lists + Recent Imports card; creator columns populated but unread | P0 | RC-1 | §5.1–5.5, §4.4, L9 | §5.1–5.2 [6][7][54][56] | `10` |
| **G02** | — | "Import at all" is not a named grant — any workspace member (incl. viewer-adjacent flows) can submit imports; market ships it as an explicit per-user permission | P1 | RC-1 | §2 (sync gate: "none — any workspace member") | §5.1 [17][79][80][117] | `10` |
| **G03** | G-A5 | Sync import job state is Redis-only — evicted at 24 h / 1 000 jobs; post-eviction `GET` 404s as if the job never existed; no durable counters or results | P0 | RC-2 | §2.1, §4.3, L3 | §6.1–6.3 [57][18][138][142] | `08` |
| **G04** | G6 | No tenant-facing import-jobs list endpoint; `listJobsByWorkspace` exists as unrouted dead code (and itself lacks an owner filter → G01) | P0 | RC-2 | §5.2, L10 | §1.1 [4], §5.2 [6][54] | `08` (API) + `11` (page) |
| **G05** | — | No cancel (or per-job retry) verb on any tenant import surface — sync has no state to transition; bulk has the `cancelled` state but no route drives it | P1 | RC-2 | §2 (route inventories), §2.2 | §6.1, §6.3 [19][56][61][60] | `08` |
| **G06** | — | Import paths bypass the shipped transactional outbox: sync enqueues directly; bulk finalize fires rollups best-effort; no durable completion events/notifications | P1 | RC-2 | §7.1, L20 | §6.1, §6.3 [129][130] | `09` |
| **G07** | G-A2 | No production object store — `diskFileStore` composed unconditionally; API and worker can't share files multi-instance | P0 ❌gate | RC-2 | §3.1, L5 | — (infra gate; design-of-record `data-management/15` §7) | `14` (gate; consumed by `08`/`12`) |
| **G08** | G-A3 | AV scanning is a permanent stub — every upload recorded `av_scan_status='skipped'`; refusal logic exists with nothing to trigger it | P0 ❌gate | RC-2 | §3.3, L7 | §1.3 (upload/artifact security envelope) | `13` (+ `14` gate) |
| **G09** | G-A4 | COPY-FROM-STDIN spike unproven — the load-bearing staging primitive carries an UNVERIFIED banner; zero prior `COPY` usage in the repo | P0 ❌gate | RC-2 | §3.2, L6 | §6.1, §6.3 [63][77] (10 k-row chunk precedent) | `12` (+ `14` gate) |
| **G10** | G-A1 | Client picks the processing path: dead-end "Large file" toggle (403s while dark, yet *recommended*); `BULK_IMPORT_THRESHOLD_ROWS` is dead config — no server-side promotion | P1 | RC-3 | §4.1, L8 | §1.2–1.3 [1][3][30] (server decides; limits as quotas) | `08` (routing) + `11` (kill the toggle) |
| **G11** | — | Poll abandonment: 1.5 s × 80 ≈ 2 min then give-up copy with nowhere to "check back"; navigation destroys the only job handle | P1 | RC-3 | §4.2 | §6.3 [56][129] (indefinite polling on durable counters) | `11` (+ `09` progress contract) |
| **G12** | — | No published import limits as product contract (per-file rows/bytes, per-workspace daily quota, concurrency) and no visible deferred/backpressure state — the 10 k shed is internal-only | P2 | RC-3 | §2.1 hop 5 | §6.1 [18][63][64] (three-layer limits; `DEFERRED` as a state) | `12` |
| **G13** | — | Import merge-strategy surface below market: `conflictPolicy` exists (default `skip`) but no update-only mode, no per-property don't-overwrite switch, no admin default | P2 | RC-5 | §2.1 hop 4 | §2.2–2.3 [1][38][79][95] | `08` |
| **G14** | — | Error artifacts below market and PII posture unaudited: no repair-CSV echoing original columns, no typed error-code vocabulary, no `_REDACTED_` redaction pass on the rejected-rows artifact | P1 | RC-3 | §2.2 hops 10–12 (reject_histogram + artifact) | §6.3 [5][58][60] | `13` (+ `08` artifact contract) |
| **G15** | — | No multi-value emails/phones anywhere in the product: overlay is single flat encrypted columns; Layer-0 channel tables are shape-only (no values, never read) | P0 | RC-4 | §6.2, L12–L13 | §3 (all) | `05` (with `04`) |
| **G16** | — | Secondaries-invisible-to-search guard: search/filter/dedup/export today bind to the single flat value; once child tables exist they must cover *all* values, or TruePoint re-creates HubSpot's top documented complaint | P1 ⚑guard | RC-4 | §6.11 (presence-facets only) | §3.1, §3.3 [10][23] | `05` (+ `12` search) |
| **G17** | — | No account hierarchy, multi-domain, or locations in the overlay — single `domain`, no `parent_account_id`, no child tables; master-graph richness never surfaced | P1 | RC-4 | §6.5, L14 | §4 (all) | `06` |
| **G18** | — | Accounts hard-delete only (no `deleted_at`) — asymmetric with contacts; blocks merge-loser tombstones and retention parity | P1 | RC-5 | §6.5, §6.12 | §2.3 [40] (soft-delete loser is the reference mechanic) | `06` |
| **G19** ◇ | — | No employment history in the overlay — flat `account_id` + denormalized title; job changes overwrite silently; Layer-0 SCD2 stints never surfaced | P2 ◇ | RC-4 | §6.6 | — (no surveyed CRM ships overlay stint history) | `04` (design intent; deferred via `14`) |
| **G20** | — | No true merge: field union + child re-pointing + loser tombstone exist nowhere; grain-A executor is marker-only annotation and does not re-point children — increasingly wrong as child tables (G15/G17) land | P1 | RC-5 | §6.9, L15 | §2.1, §2.3 [9][40][81][87] | `04` §merge (prereqs `05`/`06`; sequenced in `14`) |
| **G21** | — | No duplicate-review surface: `duplicate_of_contact_id` markers (and I5 `match_links`) accumulate with no queue/UI to accept, reject, or merge | P2 | RC-5 | §6.9 | §2.1, §2.3 [8][34][88] (persistent review queues) | `11` (+ `04` semantics) |
| **G22** ◇ | — | No field-level before/after history — `audit_log` is action-level; `field_provenance` records only the current winner per field | P2 ◇ | RC-5 | §6.10, L16 | §4.1 [15][26] (absent history cited as a vendor failure mode) | `14` §future (recorded in `07`) |
| **G23** ◇ | — | `record_tags` is FK-less polymorphism: `record_id` is a bare uuid + `entity` CHECK (`packages/db/src/schema/tags.ts:57–64`) — no referential integrity to contacts/accounts; orphan risk grows with merge/delete verbs¹ | P2 ◇ | RC-5 | —¹ (verified in this doc; outside 01's import scope) | — | `07` (constraint inventory) |
| **G24** ◇ | — | No production search adapter — `SearchPort` has only the in-memory dev adapter; channel search is presence-booleans; blocks any-value search (G16) at scale | P2 ◇ | RC-4 | §6.11, L17 | §3.3 (any-value search as leapfrog) | `12` (notes; external dep, deferred via `14`) |
| **G25** | G9 | High-volume partitioning intent unbuilt on `import_job_rows` / `source_imports` (documented-in-schema, not shipped) — the per-row ledger is unbounded growth at 2 M-row imports | P2 | RC-2 | §6.12, L19; §2.2 | §6.1 [63] (scale envelope precedent) | `12` |
| **G26** ◇ | G8 | Staff import monitor is list-only: no per-job drill-down, DLQ view, retry verb, or filters — Surface-1 scope, cross-links `database-management-research/` | P2 ◇ | RC-2 | §5.6 (surface exists, correctly locked) | §5.2 [115] (Outreach admin drill-down precedent) | `14` §future (Surface-1 handoff) |

¹ G23 is the one register entry not evidenced by doc 01 (whose scope was import + import-adjacent
model); it was re-verified directly against the schema for this register. If doc 01 gains a tags
section in a future revision, this evidence pointer moves there.

### Alias map (brief working IDs → register)

| Working ID | Register | Working ID | Register | Working ID | Register |
|---|---|---|---|---|---|
| G-B1 | **G01** | G-A2 | **G07** | G6 | **G04** |
| G-A1 | **G10** | G-A3 | **G08** | G8 | **G26** |
| G-A5 | **G03** | G-A4 | **G09** | G9 | **G25** |

### Root-cause coverage check

| RC | Gaps |
|---|---|
| RC-1 visibility leak | G01, G02 |
| RC-2 dual-pipeline split | G03, G04, G05, G06, G07, G08, G09, G25, G26 |
| RC-3 perceived breakage | G10, G11, G12, G14 |
| RC-4 single-channel schema | G15, G16, G17, G19, G24 |
| RC-5 marker-only dedup/merge | G13, G18, G20, G21, G22, G23 |

Every gap maps to exactly one primary root cause; cross-dependencies are stated in the row
(e.g., G04→G01, G16→G15, G20→G15/G17/G18). The P0 set — G01, G03, G04, G15, plus the three
❌-gates G07/G08/G09 — is the minimum bar for the two reported problems to be *materially*
resolved; the roadmap (doc 14) phases them first, with the gates cleared in their phase per
confirmed program decision 2.

---

## Gaps (template section pointer)

This entire doc *is* the series' Gaps artifact: Part 2 is the normative register. Design docs
`04`–`15` cite `02 §Gnn` and must not restate evidence — evidence lives in doc 01, practice in
doc 03, and the linkage here.
