# 06 — Company Schema Design

> **Status of this doc:** complete (design doc — target state 🔲 not built; nothing here ships
> from this series). Evidence cites [`01-Current-State-Audit.md`](01-Current-State-Audit.md),
> gaps cite [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md), external
> practice cites the register in [`03-Enterprise-Research.md`](03-Enterprise-Research.md) only.
> **Owns:** gaps **G17** (no hierarchy/multi-domain/locations in the overlay) and **G18**
> (accounts hard-delete asymmetry). Feeds doc `07` (ER/constraints), doc `08` (company match
> ladder at import), and doc `04` §merge (account tombstones are a merge prerequisite, G20).

---

## Objective

Design the target state of the per-workspace `accounts` overlay: a self-referential
**hierarchy** (`parent_account_id` + optional denormalized `root_account_id`), a
**multi-domain** child table (`account_domains`) with the existing flat `domain` column retained
as the primary-value cache, a **locations** child table (`account_locations`) with the flat
`hq_country`/`hq_city` columns as the primary-location cache, **soft-delete** (`deleted_at`),
and the **company dedup/match ladder** the import pipeline (doc `08`) executes. Deliberately
**symmetric with doc `05`** — child tables + flat primary-cache column is one pattern applied to
contacts' channels and accounts' domains/locations alike; doc `05` owns the shared cache-sync
rationale, this doc states only the account-specific deltas.

## Reconciliation (what is pinned; what this doc does not change)

Builds on doc 01 §6.5's as-is: `accounts` has one `domain` (the per-workspace dedup key,
`packages/db/src/schema/contacts.ts:52,83–85`), **no** `parent_account_id`, **no**
domain/location child tables, **no** `deleted_at` — hard-delete only (01 §6.5, L14; contrast
`contacts.deleted_at`, `contacts.ts:165`). Pinned decisions this design must not and does not
contradict:

- **DM4 — tenancy unchanged.** Every new table carries `tenant_id` + `workspace_id`, gets
  `ENABLE`+`FORCE` RLS on the fail-closed workspace GUC, and is reached only via `withTenantTx`
  (`../data-management/00-overview.md` §DM4; policy shape quoted in §Security below).
- **DM1 — one canonical primitive set.** Domain normalization is the shipped eTLD+1
  registrable-domain normalizer + freemail guard (`../data-management/02-identity-and-dedup.md`
  §1); this doc introduces **no** parallel normalizer.
- **DM6 / doc 05 split — provenance.** The flat cached columns (`domain`, `hq_country`,
  `hq_city`) stay governed by the `field_provenance` jsonb winner-map (`contacts.ts:73`);
  **child rows carry their own per-row provenance columns** (`source`, `source_import_id`,
  `pinned`, `verified_at`). Same resolution as doc 05's channel rows — cross-ref doc 05
  §provenance for the rationale; it is not restated here.
- **ADR-0028 untouched.** `accounts.custom_fields` stays jsonb (`contacts.ts:70`); nothing here
  moves custom fields into columns.
- **Layer-0 untouched.** `master_companies.parent_company_id` and `alt_domains[]`
  (`packages/db/src/schema/masterGraph.ts:63,58`) remain the system-owned truth. They are
  **surfaced as accept/reject suggestions only** — an accepted suggestion is an ordinary overlay
  write to `parent_account_id`/`account_domains`; the master graph is never written from this
  path and never read directly by tenant queries (isolation by access path, 01 §6.1). This
  matches how CRMs consume vendor hierarchy feeds (03 §4.1 [98][106]).
- **Company-first ER preserved.** Dedup on domain, distrust the name: the registrable domain is
  the strongest company key and normalized name is only a fuzzy fallback — the shipped ladder
  and master-graph key design (`../data-management/02-identity-and-dedup.md` §1, DM5;
  `masterGraph.ts:57–60`). §Dedup ladder below refines, never inverts, that order.

**Not changed by this doc:** the contacts schema and channel tables (docs `04`/`05`), the import
pipeline itself (doc `08` — this doc only hands it the match ladder), job visibility (doc `10`),
search adapters (G24, doc `12`), any rollup computation (§Rollups — explicitly future), and all
of Layer-0.

---

## Current Challenges

- One `domain` per account: multi-domain companies (country TLDs, acquired brands, redirects)
  cannot be represented; a second domain arriving from import/enrichment is silently dropped or
  mints a duplicate account (G17, 01 §6.5).
- No hierarchy: subsidiaries and parents are unrelated rows; family-level views are impossible.
- No locations: `hq_country`/`hq_city` freetext is the entire address model; multi-office
  companies cannot support office-level contact assignment or territory filtering.
- Hard-delete only: deleting an account destroys provenance, orphans nothing visibly (contacts
  SET NULL, `contacts.ts:109`), leaves no tombstone — and blocks merge-loser semantics (G18,
  RC-5, 02 §RC-5).

## Enterprise Best Practices (cited — register in doc 03)

- Hierarchy = a single parent pointer, tree derived by walking; cycles rejected at write time
  (self-reference blocked; `CIRCULAR_DEPENDENCY` on edit **and merge**) — Salesforce
  (03 §4.1 [46][47][48][73]); HubSpot enforces single-parent and a **merge-time loop guard**
  (03 §4.1 [14]).
- Vendors denormalize the ultimate parent onto every node: D&B ships 4 pointer DUNS per record
  incl. Global Ultimate with a 2-digit hierarchy code 01–09 (a 9-level ceiling); ZoomInfo ships
  ~55 denormalized hierarchy fields, Ultimate Parent re-pointed after acquisitions
  (03 §4.1 [104][105][98][101]).
- Multi-domain with an explicit primary: HubSpot's `Company domain name` is a set; **primary =
  the dedup key; the whole set = match input** (import dedup uses primary and secondary
  domains); Clearbit resolves any `domainAliases` member to the canonical company
  (03 §4.1 [15][8][112]).
- HubSpot's documented secondary-domain asymmetries are the named failure modes to avoid:
  **(a)** multiple domains cannot be imported, **(b)** the primary cannot be set via import,
  **(c)** secondaries are not exported and have no property history (03 §4.1 [15][26]).
- No surveyed CRM ships a customer-facing locations child object — flat HQ address, extra
  offices as extra account records; data vendors model every site as its own record, and
  location-grained identity keys **fragment accounts** ("a firm with 40 offices has 40 DUNS
  Numbers") (03 §4.1 [46][14][104][107][108][111][103][99]).
- CRMs compute **no** hierarchy rollups (display-only; a third-party market fills the gap);
  vendors precompute family figures keyed on the ultimate-parent pointer
  (03 §4.1 [74][75][29][106][100]).
- Hierarchy is orthogonal to permissions ("the hierarchy doesn't display details of accounts you
  don't have permission to view") (03 §4.1 [47]).
- Import matching: domain-first exact decides create-vs-update; ≥2 matches on one row **error
  loudly** (HubSpot) or prompt (Apollo); fuzzy name+geo is advisory/review-layer only, never a
  silent import key (03 §4.1 [8][82][49][50][51]).

## Gaps addressed

| Gap | This doc's answer |
|---|---|
| **G17** (P1, RC-4) | `parent_account_id` (+ optional `root_account_id`), `account_domains`, `account_locations` — §§Solution 1–3 |
| **G18** (P1, RC-5) | `accounts.deleted_at` + tombstone semantics — §Solution 4 |
| G20 (owned by `04`) | prerequisite delivered here: merge losers can tombstone; merge-time cycle re-validation specified §Solution 2 |
| G13 (owned by `08`) | consumes this doc's match ladder — §Solution 5 |

---

## Recommended Solution

### 1. `account_domains` — multi-domain child table 🔲

One row per domain an account is known by. Domains are **not PII** (clear text, citext — same
posture as the existing `accounts.domain` and `contacts.email_domain` clear facets,
`contacts.ts:52,122`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | `uuid_generate_v7()` |
| `tenant_id` / `workspace_id` | uuid NOT NULL | DM4; FK cascade, same factories as `contacts.ts:32–39` |
| `account_id` | uuid NOT NULL | FK → `accounts.id` ON DELETE CASCADE (hard delete = retention purge only, §4) |
| `domain` | citext NOT NULL | normalized eTLD+1 (DM1 normalizer); freemail-guarded at the app edge |
| `is_primary` | boolean NOT NULL default false | exactly-one-primary invariant, below |
| `source` | varchar(30) NOT NULL | CHECK: `import` \| `enrichment` \| `manual` \| `master_suggestion` |
| `source_import_id` | uuid | lineage pointer to the originating `source_imports` row (the contact-import row that carried the domain); FK ON DELETE SET NULL — same mechanics as doc 05's shared column (retention may reap `source_imports`, 05 §1.1); the bare-uuid idiom stays confined to job ledgers (`import_job_rows`) |
| `pinned` | boolean NOT NULL default false | pinned rows are never detached/demoted by import or enrichment (DM6 pin semantics, per-row form) |
| `verified_at` | timestamptz | last time the domain was confirmed live/owned (enrichment sets it); NULL = never |
| `deleted_at` | timestamptz | soft-detach tombstone |
| `created_at` / `updated_at` | timestamptz NOT NULL | standard |

**Constraints & indexes**

- `uniq_account_domains_ws_domain` — partial unique `(workspace_id, domain)` **WHERE
  `deleted_at IS NULL`**: a domain belongs to at most one live account per workspace. This
  *strengthens* today's invariant (`uniq_accounts_ws_domain`, `contacts.ts:83–85`) from
  primary-only to the whole set — which is what makes "any-domain exact" a safe match rung (§5).
- `uniq_account_domains_primary` — partial unique `(account_id)` **WHERE `is_primary AND
  deleted_at IS NULL`**: at most one live primary per account. "Exactly one when any live row
  exists" is the app-enforced half (the DB can express at-most-one); the single writer (below)
  maintains it, and the reconciliation query (§Testing) detects violations.
- `idx_account_domains_account` — `(account_id)` partial WHERE `deleted_at IS NULL` (render the
  set on the account drawer).
- RLS: the standard workspace-isolation policy (§Security).

**Primary cache contract.** `accounts.domain` becomes the denormalized cache of the primary
`account_domains` row — the **same sync contract shape as doc 05's flat channel columns**
(single writer updates child row + cache in one `withTenantTx`; promotion = atomic swap of
`is_primary` + cache rewrite; cache never diverges silently — drift detection in §Testing).
Search facets, the dedup fast rung, exports, and the COPY-staging encoder keep binding to the
flat column unchanged; nothing that reads `accounts.domain` today breaks. Doc 05 owns the full
rationale; this table only inherits it.

**Import collision policy (feeds doc 08).** A row whose domain already exists on another
account is not an error by default — it is **the match signal**: domain-exact resolves to that
account and the row proceeds as an *update* under the row's conflict policy (HubSpot: primary =
dedup key, whole set = match input, 03 §4.1 [15][8]). Review is triggered only on **ambiguity**:
the row carries ≥2 domains resolving to ≥2 distinct live accounts → the row fails loudly to
review, never a silent pick (03 §4.1 [8][82]). An import **never moves** a domain from one
account to another as a side effect — moving is an explicit verb (§Edge cases). And the three
HubSpot asymmetries are explicitly designed out from day one (03 §4.1 [15][26]):

1. **Multiple domains import** — the mapping supports a multi-domain column (delimiter-split);
   each lands as an `account_domains` row.
2. **Primary settable via import** — the first-listed (or explicitly flagged) domain may set the
   primary on *create*; on *update* the primary changes only if the incoming row explicitly
   requests it and the current primary is not `pinned`.
3. **Secondaries are first-class in export and history** — exports emit primary + delimited
   secondaries; every attach/detach/promote writes `audit_log`.

### 2. `parent_account_id` — workspace-local hierarchy 🔲

A single self-referential pointer on `accounts`; the tree is derived, never stored (03 §4.1
[46]). The overlay hierarchy is a **workspace-local assertion** — tenant A's claim that X is a
subsidiary of Y — independent of Layer-0's `parent_company_id`, which only feeds suggestions.

| Column (on `accounts`) | Type | Notes |
|---|---|---|
| `parent_account_id` | uuid NULL | composite FK, below; NULL = no asserted parent |
| `root_account_id` | uuid NULL | **recommended** denormalized ultimate parent; NULL = "I am the root"; family key = `COALESCE(root_account_id, id)` |

**Cross-workspace parent must be structurally impossible.** A plain FK to `accounts(id)` is
checked with table-owner rights and therefore **bypasses RLS** — a client could point
`parent_account_id` at another workspace's uuid and the FK would pass. The fix is mechanical:
add `uniq_accounts_ws_id` unique `(workspace_id, id)` and declare the **composite FK
`(workspace_id, parent_account_id) REFERENCES accounts (workspace_id, id)`** — same-workspace
parentage is then a database invariant, not an app promise. (App validation still rejects it
first with a clean RFC 9457 error; the FK is the backstop.) `ON DELETE` is not relied on for
tombstones (soft-delete splices children, §4); for the rare hard purge, `SET NULL` is the
safety net so a purge never cascades a family away (mirrors the master-graph stance,
`masterGraph.ts:62–63`).

**Self-parent** is blocked twice: CHECK `(parent_account_id IS NULL OR parent_account_id <> id)`
plus the app validation (Salesforce blocks self-reference at write time, 03 §4.1 [48]).

**Cycle prevention = write-time app validation** — the universal pattern (Salesforce
`CIRCULAR_DEPENDENCY` [48][73]; HubSpot merge loop guard [14]); the DB cannot cheaply express
acyclicity. On every `parent_account_id` write, inside the same `withTenantTx`:

1. Lock the two endpoint rows `FOR UPDATE` in deterministic id order (closes the obvious
   concurrent A→B / B→A race; residual multi-edit races are caught by the detector, §Testing).
2. Walk ancestors of the proposed parent by recursive CTE (RLS keeps it workspace-scoped):

```sql
WITH RECURSIVE anc AS (
  SELECT id, parent_account_id, 1 AS depth
    FROM accounts WHERE id = :proposed_parent
  UNION ALL
  SELECT a.id, a.parent_account_id, anc.depth + 1
    FROM accounts a JOIN anc ON a.id = anc.parent_account_id
   WHERE anc.depth < 10
)
SELECT bool_or(id = :child_id) AS cycle, max(depth) AS parent_depth FROM anc;
```

3. Reject if `cycle`, and reject if `parent_depth + subtree_depth(:child_id) > 10`.

**Depth cap = 10.** D&B's hierarchy code is 2-digit 01–09 — a 9-level ceiling suffices for
global corporate trees (03 §4.1 [104][105]); Salesforce has no native limit but practical
formula workarounds cap ~10 levels (03 §4.1 [46][74]). 10 keeps the CTE bounded and covers the
deepest real trees; it is a validation constant, not a schema property.

**Merge-time re-validation is mandatory.** Account merge (doc `04` §merge mechanics, G20)
re-runs the same check treating the survivor as inheriting both parties' parent/child edges —
merging a parent-child pair or two accounts whose families would chain to themselves is blocked
until the edge is removed, exactly HubSpot's guard (03 §4.1 [14]).

**`root_account_id` — include it.** The D&B/ZoomInfo pattern denormalizes the ultimate parent
onto every node precisely so family reads are `GROUP BY family key`, not recursive CTEs
(03 §4.1 [104][98]); it also gives the dedup/review UI a cheap same-family check (a fuzzy name
match *within* a family is usually a subsidiary, not a duplicate). **Maintenance cost, stated:**
every `parent_account_id` change must recompute `root_account_id` for the moved node **and its
entire subtree** in the same tx (bounded: depth ≤ 10, and families are small relative to
workspaces); merge re-points the loser's subtree to the survivor's root; the nightly detector
(§Testing) reconciles drift. Index: `idx_accounts_ws_root` `(workspace_id, root_account_id)`
partial WHERE `root_account_id IS NOT NULL`.

**Hierarchy is display/rollup-only — orthogonal to permissions** (03 §4.1 [47]). It never
widens visibility: family views render only rows the caller's RLS/visibility already admits
(doc `10`); no permission, sharing, or ownership semantics ever attach to the tree.

**Master suggestions.** Where `accounts.master_company_id` is set and the master node carries
`parent_company_id` or `alt_domains` entries the overlay lacks, the account drawer offers
"suggested parent / suggested domains" chips; **accept** performs the ordinary validated overlay
write (with provenance `source = 'master_suggestion'`), **reject** records a dismissal so the
suggestion doesn't nag. Suggestion-surfacing reads Layer-0 through the existing bridge
projection path only — never a tenant-query join to `master_companies` (01 §6.1).

### 3. `account_locations` — offices child table 🔲

| Column | Type | Notes |
|---|---|---|
| `id`, `tenant_id`, `workspace_id` | — | as in §1 |
| `account_id` | uuid NOT NULL | FK → accounts, ON DELETE CASCADE |
| `type` | varchar(10) NOT NULL | CHECK: `hq` \| `branch` \| `office` |
| `line1` / `line2` | varchar(255) | street address |
| `city` | varchar(100) | |
| `region` | varchar(100) | state/province, freetext |
| `postal_code` | varchar(20) | |
| `country` | char(2) NULL | ISO-3166 alpha-2; NULL when the source was unmappable freetext (backfill honesty, §Steps S-A3) |
| `is_primary` | boolean NOT NULL default false | at-most-one live primary per account (partial unique, as §1) |
| `source` / `source_import_id` / `pinned` | — | provenance trio, as §1 |
| `deleted_at`, timestamps | — | as §1 |

Company office addresses are public firmographics, not personal PII — stored clear, same
posture as today's `hq_country`/`hq_city` (`contacts.ts:59–60`).

**Locations are subordinate to company identity — NEVER a dedup key.** The match ladder (§5)
takes no location input; location-grained identity is the documented account-fragmentation trap
("a firm with 40 offices has 40 DUNS Numbers", 03 §4.1 [99][104]). One company = one account =
N location rows.

**Deliberate divergence, named.** No surveyed CRM ships a customer-facing locations child
object (03 §4.1 [46][14][104][107][108][111][103]) — their answer is extra account records via
the parent pointer, which *is* the fragmentation trap for a sales-intelligence product. We
diverge because TruePoint's workflows need offices *under one identity*: assigning contacts to
an office (`contacts` would gain an optional `account_location_id` — recorded here as the
consuming edge; **deferred**: no S-C\* step ships it in this series, tracked in doc `07`'s DDL
inventory as adjacent-scope), territory/region filtering over offices, and
enrichment landing per-site data (ZoomInfo treats locations as enrichable entities, [103]).

**HQ flat cache.** `hq_country`/`hq_city` become the primary-cache of the primary (`type='hq'`
preferred) location row — same contract as §1. Caveat carried honestly: the flat columns are
freetext today ("United States") while the child stores ISO alpha-2; the cache write derives
the display name from the code, and the backfill maps known names → codes best-effort (S-A3),
leaving `country` NULL where unmappable rather than guessing.

### 4. Accounts soft-delete — `deleted_at` (G18) 🔲

Add `accounts.deleted_at timestamptz NULL`, symmetric with `contacts.deleted_at`
(`contacts.ts:165`). Semantics:

- **Contacts keep their pointer.** `contacts.account_id` is *not* nulled on soft-delete — the
  tombstone preserves restore and merge-forensics. Read paths treat a tombstoned account as
  absent: account lists/search/dedup exclude `deleted_at IS NOT NULL`; a contact whose account
  is tombstoned renders company-less (the join filters). The existing `ON DELETE SET NULL`
  (`contacts.ts:109`) remains, but only fires on the rare hard purge.
- **Children tombstone in the same tx.** Soft-deleting an account sets `deleted_at` on its live
  `account_domains` and `account_locations` rows — this **releases the domains** under the
  partial uniques (§1), so the workspace can re-create the company later. Hierarchy: children
  pointing at the tombstone are **spliced to its parent** (`parent_account_id = deleted row's
  parent`, may be NULL) and their subtree roots recomputed, in the same tx — a tombstone is
  never an interior tree node.
- **Import upsert on a tombstoned account creates a new account, never resurrects.** The match
  ladder (§5) matches live rows only (`deleted_at IS NULL`); silent resurrection would undo a
  user's deliberate delete with their old data. Restore is an explicit verb (un-tombstone
  account + children, re-validated against the partial uniques — a conflict fails loudly).
- **Merge-loser tombstone.** Doc `04`'s merge mechanics require exactly this: re-point children
  to the survivor → tombstone the loser (Salesforce reference mechanics, 03 §2.3 [40]). G18 was
  the blocker; this removes it.
- **Retention/DSAR alignment.** Tombstones are not forever: accounts get a retention class in
  the shipped (inert) retention engine — cross-link
  [`../data-management/16-retention-engine-design.md`](../data-management/16-retention-engine-design.md)
  — whose enforce-mode sweep performs the hard purge of expired tombstones (CASCADE then removes
  child rows; contacts SET NULL). Company data is not personal PII, so DSAR pressure is low,
  but provenance rows referencing the account survive as uuid pointers by design.
- **Why hard-delete-with-cascade is disqualifying once child tables exist:** a hard DELETE
  would silently cascade the domain/location evidence away, SET-NULL contacts with no
  tombstone to explain why, destroy the audit trail's referent, and make merge-loser semantics
  (G20) and retention shadow-accounting (data-management/16's shadow-first posture)
  unimplementable. Soft-delete-then-swept-purge is the only shape compatible with all three.

### 5. Company dedup/match ladder for import (feeds doc 08) 🔲

Executed per import row, over **live rows only**, after DM1 normalization (eTLD+1 + freemail
guard — a freemail domain never matches or mints an account):

| Rung | Signal | Action |
|---|---|---|
| **C1** | primary-domain exact — `accounts.domain` cache hit | match; proceed under conflict policy |
| **C2** | any non-deleted `account_domains.domain` exact | match (the [15][8]/[112] whole-set rule); proceed |
| **C3** | normalized name + country | **REVIEW-ONLY suggestion** — never a silent auto-merge or auto-update key (fuzzy name+geo is advisory-layer everywhere, 03 §4.1 [49][50][51]) |
| **Ambiguity** | the row's domains resolve to ≥2 distinct accounts | row **fails loudly to review** (HubSpot row-errors / Apollo prompts, 03 §4.1 [8][82]) |

C1 is a fast-path of C2 (the cache is index-backed today, `contacts.ts:83–85`); semantically
they are one rung — the split exists so the hot path costs one probe. The ladder preserves the
company-first ER rule: **dedup on domain, distrust the name** (Reconciliation; DM5). C3 hits
land in the duplicate-review queue (doc `11`, G21) with the same-family check from
`root_account_id` (§2) attached, so reviewers see "same corporate family" context before
merging. Domainless rows (no C1/C2/C3 hit) create a new account; domainless *matching* is
name+country suggestion only.

### 6. Rollups stance — FUTURE 🔲

Hierarchy **display** ships with §2 (an indented family view on the account drawer). Family
**rollups** (aggregate employee count, contact counts across subsidiaries) are deliberately out
of this program: no surveyed CRM computes them (display-only; third parties fill the gap,
03 §4.1 [74][75][29][100]); `root_account_id` exists so a future rollup is a cheap
`GROUP BY COALESCE(root_account_id, id)` (the vendor precompute pattern, [106][100]) — but no
rollup machinery, no materialized aggregates, no scheduled recompute ships from this series.
Master hierarchy stays a suggestion layer (§2), consistent with that stance.

---

## Implementation Steps (step IDs; sequencing owned by doc 15 — never fixed migration numbers)

| Step | Contents | Reversible? |
|---|---|---|
| **S-A1** | Create `account_domains` (+ RLS policies, updated_at trigger, grants). **Backfill:** one primary row per account WHERE `domain IS NOT NULL` (`is_primary = true`, `source = 'import'`, `verified_at = NULL`); idempotent (`ON CONFLICT DO NOTHING` on the ws+domain unique). **The backfill re-runs after S-A2 is live** to close the write-gap tail — dual-write precedes the *final* backfill pass, per doc 05 §Implementation's ordering refinement (accounts written between the first pass and dual-write-on would otherwise lack child rows) | yes — drop table; flat column untouched |
| **S-A2** | Dual-write: the account write path (import upsert, enrichment, manual edit) writes child + cache in one tx; reads stay on the flat cache | yes — revert writer; cache remains authoritative |
| **S-A3** | Create `account_locations` (+ RLS). Backfill primary `hq` row from `hq_country`/`hq_city` best-effort (name→ISO map; unmappable → `country NULL`, city carried) | yes — drop table |
| **S-A4** | Add `parent_account_id`, `root_account_id`, `uniq_accounts_ws_id`, the composite same-workspace FK, self-parent CHECK, `idx_accounts_ws_root`. No backfill (hierarchy starts empty; master suggestions populate it organically) | yes — drop columns/constraints |
| **S-A5** | Add `accounts.deleted_at`; swap the domain uniques to include `AND deleted_at IS NULL` (create new partial unique → drop old, online); add partial `WHERE deleted_at IS NULL` to the account list/search indexes as doc 12 directs | yes — column drop + index swap-back |
| **S-A6** | Read cutover behind a per-tenant flag (the shipped dual-gate pattern, 01 §7.3): account API returns `domains[]`/`locations[]`/hierarchy fields; ladder rung C2 activates. Flag-off = byte-identical current behavior | yes — flag off |

All steps are **additive**; the flat columns are retained permanently as the primary cache
(locked spine; same posture as doc 05). No step renames or drops an existing column.

## UI/UX (pointer — doc 11 owns the surfaces)

Account drawer gains: domains list (primary badge, promote/attach/detach, pinned lock),
locations list (type badge, primary), family tree (indented, tombstone-free), master
suggestions (accept/reject chips), delete → soft-delete with undo-window copy. Duplicate review
(G21) shows the same-family hint. All `@leadwolf/ui`, four-state `StateSwitch` — per
truepoint-design; not designed here.

## DB & Backend — pre-build reasoning pass (explicit answers)

Per `truepoint-architecture/references/pre-build-thinking.md`; answers cite the owning skills.

- **Source of truth.** Per domain/location value: its child row. Per primary: the child row's
  `is_primary`; the flat columns are a **cache** (single-writer sync contract, doc 05). Family
  membership: `parent_account_id` (derived: `root_account_id`, recomputed on every edge write).
  Hierarchy truth is the overlay's own assertion; Layer-0 is a suggestion source, never a
  second writer. On conflict, child rows win and the reconciliation job repairs the cache —
  post-S-A6 cutover; while S-A2 dual-write runs the flat cache stays authoritative (the same
  phase rule as doc 05 §3.4).
- **Failure modes.** (1) *Cycle introduced by merge or concurrent edits* — write-time CTE check
  + FOR-UPDATE endpoint locks + mandatory merge re-validation (§2); residual: nightly cycle
  detector (§Testing) alerts and the family view renders depth-capped (never infinite-loops:
  every walk carries `depth < 10`). (2) *Cache drift* (flat ≠ primary child) — single writer in
  one tx; drift query in the reconciliation job; alert, auto-repair from child. (3) *Orphaned
  domains* (live child rows under a tombstoned account) — impossible by construction (same-tx
  child tombstoning, §4) + detector query as backstop. (4) *Backfill partial failure* —
  idempotent per-row upserts; re-run converges.
- **Duplicate prevention.** DB-level: the two partial uniques (§1) are the invariant; the
  import upsert relies on `ON CONFLICT` against them, so a raced double-attach collapses.
  Idempotency-Key on the API writes (platform contract). The dedup key is the normalized
  registrable domain — never name, never location (§5).
- **Audit & history.** Every attach/detach/promote/parent-change/soft-delete/restore writes the
  append-only `audit_log` (01 §6.10) with actor + before/after ids in the same tx as the
  mutation (not fire-and-forget — a lost audit row on these verbs is a compliance gap). Field
  history beyond that is G22, explicitly deferred (02 §G22).
- **Security** (truepoint-security checklist): every new table carries `tenant_id` +
  `workspace_id` and gets the exact shipped policy idiom, FORCE'd, fail-closed
  (`packages/db/src/rls/contacts.sql:20–22` shape):

  ```sql
  ALTER TABLE account_domains ENABLE ROW LEVEL SECURITY;
  ALTER TABLE account_domains FORCE ROW LEVEL SECURITY;
  CREATE POLICY account_domains_workspace_isolation ON account_domains
    USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid)
    WITH CHECK (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::uuid);
  ```

  (identically for `account_locations`). Cross-workspace parent is impossible at the DB via the
  composite FK (§2 — closes the FK-bypasses-RLS hole; client-supplied parent/account ids are
  additionally re-fetched under RLS before use, the standing IDOR rule,
  `../data-management/02-identity-and-dedup.md` §2.3). Domains and company addresses are
  non-PII (no encryption/blind-index machinery needed — deliberate contrast with doc 05's
  channel values); nothing here is logged beyond ids. Hierarchy never widens visibility (§2,
  [47]). All writes ride existing authn/tenancy middleware + org-role gates (doc 10 owns which
  role may merge/delete).
- **Scalability** (truepoint-platform): expected cardinality is small-N per account (domains
  ≤ ~10, locations ≤ ~100 for pathological cases); all reads are `(workspace_id, account_id)`
  or `(workspace_id, domain)` index probes — no new unbounded lists (child sets render fully;
  the accounts *list* stays cursor-paginated). Hierarchy walks are recursive CTEs bounded by
  depth 10 within one workspace's rows — cheap; family aggregation avoids walks entirely via
  `root_account_id` (§2, the [104][98] pattern). Import-time ladder cost: one probe per rung.
  At 10x: the partial uniques and probes scale with the account table; nothing here adds a
  fan-out write path (subtree root recompute is bounded by family size and rare).
- **Monitoring.** Counters: domains attached/detached per import, ladder rung hit-rates
  (C1/C2/C3/ambiguity → doc 08's import metrics), review-queue inflow from C3, cycle-detector
  and cache-drift detector results (0 = healthy), tombstone count + purge lag (retention
  dashboards, data-management/16). Structured logs carry ids only.
- **Rollback.** Every step S-A1…S-A6 is additive and individually reversible (table);
  behavior activates only behind the S-A6 per-tenant flag — flag-off restores byte-identical
  current reads. Down-migrations are written with each up (pre-build mandate).
- **Edge cases.** *Self-parent* — CHECK + validation (§2). *Cross-workspace parent attempt* —
  composite FK makes it impossible; API 404s the foreign id before that (RLS re-fetch).
  *Domain moved between accounts* — explicit verb only: detach (tombstone) on A + attach on B
  in one tx, both audited; import/enrichment may **suggest** a move (review), never perform it;
  `pinned` rows refuse even the suggestion-accept without unpin. *Tombstoned-domain re-attach*
  — the partial unique admits it (old row `deleted_at` set); attach creates a fresh row, so
  provenance never mutates. *Account with zero live domains* — legal (domainless companies
  exist, cf. Layer-0's nullable `primary_domain`, `masterGraph.ts:57`); cache goes NULL; ladder
  matches it only via C3 review. *Empty/unknown `type` or `source` enum values* — CHECKs reject;
  Zod rejects earlier with RFC 9457. *Two users editing the hierarchy simultaneously* —
  FOR-UPDATE ordering + detector (§2).
- **Assumptions** (written down): families stay ≤ 10 deep and small-N wide (detector alerts if
  violated); domain normalization stays the single DM1 implementation; `apps/web` renders
  child sets unpaginated because of the small-N assumption; the retention engine (inert today)
  is the eventual purge executor — until enforce-mode flips, tombstones simply accumulate
  (acceptable: they are excluded from every read path).
- **Misuse.** A user scripting 10k domain-attaches: per-route rate limit + a per-account cap
  (domains ≤ 50, locations ≤ 200 — quota constants in config, RFC 9457 on breach); import rows
  respect the same caps with reject-code accounting (doc 08). Deep-tree abuse: depth cap.
  Mass soft-delete: bounded by the existing bulk-verb limits (grain-A `execBulkDelete`'s ≤1000
  posture, 01 §6.9) when a bulk verb arrives; single-account delete is unbounded but audited.
- **Worst case + detection.** Worst: a defective merge or backfill re-points
  `parent_account_id`/`root_account_id` en masse, or tombstones accounts wrongly — corrupting
  family structure across a workspace. Detectable before completion: merges and backfills run
  row-bounded with counters; the nightly detector (cycles, root drift, cache drift, orphan
  children) alerts on any nonzero. Recoverable: soft-delete is reversible (restore verb);
  hierarchy edges are re-derivable from audit_log entries; nothing in this design hard-deletes
  outside the retention sweep. A mutation that is neither detectable nor recoverable does not
  exist in this design — that is the point of tombstones + additive steps.

## API (contract deltas — full route design in doc 08/07)

- `@leadwolf/types` account shapes evolve additively (shared-Zod source of truth, platform
  contract): `AccountSchema` gains `domains: AccountDomain[]`, `locations: AccountLocation[]`,
  `parentAccountId`, `rootAccountId`, `deletedAt`; `AccountDomain = { id, domain, isPrimary,
  verifiedAt, source, pinned }`; `AccountLocation = { id, type, line1, line2, city, region,
  postalCode, country, isPrimary, source, pinned }`. List payloads keep the flat `domain`
  (cache) so existing consumers are untouched until they opt into the expanded shape.
- New verbs (all `/api/v1`, Idempotency-Key, RFC 9457, org-role-gated per doc 10):
  `POST/DELETE /accounts/:id/domains`, `POST /accounts/:id/domains/:domainId/promote`,
  `POST/PATCH/DELETE /accounts/:id/locations`, `PATCH /accounts/:id` (parent set/clear —
  runs §2 validation), `DELETE /accounts/:id` (soft), `POST /accounts/:id/restore`,
  `GET /accounts/:id/family` (depth-capped tree, visibility-filtered).
- Import mapping contract (doc 08): multi-domain column, optional primary flag, optional
  parent-by-domain/id association column (the [14] pattern: hierarchy links ride the file,
  resolved through the §5 ladder; unresolvable parents → review, never dangling).

## Testing hooks

- **RLS itests** for both new tables (the `importJobs.itest` pattern): cross-workspace read =
  0 rows; unset GUC = 0 rows; composite-FK cross-workspace parent insert fails.
- **Ladder property tests:** C1≡C2 on primaries; freemail never matches; ambiguity → review
  outcome; tombstoned rows never match; within-file two rows same domain collapse to one
  account (doc 08's within-file dedup).
- **Cycle tests:** self-parent, 2-cycle, 10-deep chain accepted, 11-deep rejected, merge-created
  cycle rejected; concurrent A→B/B→A race leaves the detector clean.
- **Invariant/reconciliation queries** (shipped as the nightly detector + test assertions):
  exactly-one-primary per live-domained account; cache = primary child; no live child under a
  tombstoned account; `root_account_id` consistent with a fresh walk; zero cycles.
- **Backfill idempotency:** S-A1/S-A3 run-twice = run-once; row counts reconcile to
  `COUNT(domain IS NOT NULL)`.
- **Flag-off byte-identity:** with S-A6 off, account API responses are byte-identical to
  pre-series behavior.

## Rollout

S-A1→S-A5 are dark schema/dual-write steps (no behavior change flag-off); S-A6 is the
per-tenant read cutover on the shipped dual-gate control plane (01 §7.3), enabling internal
workspaces first. Sequencing against docs 04/05/08 (channel tables and import unification) is
owned by doc `15`; the one hard edge: **doc 04's merge executor must not ship before S-A5
(tombstones) and S-A1 (domain demotion target) exist** (02 §RC-5 ordering).

## Success metrics

- 0 cross-workspace rows reachable in RLS itests; 0 composite-FK violations in prod (alert).
- Duplicate-account rate on multi-domain companies ↓ (C2 rung hit-rate > 0 and climbing;
  new-account-created-for-existing-domain-family incidents → review queue instead).
- Detector steady-state: 0 cycles, 0 cache drift, 0 orphaned children, root consistency 100%.
- Import parity: multi-domain columns land as rows (no silent drops — the [15][26] asymmetries
  absent by test); exports round-trip secondaries.
- 100% of account deletes are tombstones (hard deletes only from the retention sweep);
  merge-loser tombstone path unblocked for doc 04 (G18 closed; G17 closed at S-A6).
