# 07 — Deduplication & Linking

> **Series:** [Database Management](./README.md) · **Type:** Design · **Status:** ✅ Authored · **Prev:**
> [`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) · **Next:**
> [`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md)

## Objective

Specify TruePoint's **deduplication, entity resolution (ER), and company↔person linking** subsystem and the
staff-facing **clerical-review queue** the schema already anticipates but no UI exposes. This document covers
two distinct dedup tiers that must never be conflated:

1. **Within-workspace contact dedup** (Layer-1 overlay) — auto-survivorship keyed on
   `contacts.duplicate_of_contact_id`. **Status: Shipped** (worker writes the survivor link; there is no UI).
2. **Cross-source entity resolution** (Layer-0 master graph) — golden-entity clustering over
   `match_links`, deterministic-shipped and probabilistic-deferred. **Status: Partial** — deterministic
   `match_method='deterministic'` / `review_status='auto'` writes ship; Splink probabilistic scoring,
   `match_probability`, and the `pending/confirmed/rejected` clerical queue are scale-track columns present at
   schema freeze but **inert** with no producer and no operator surface. `masterGraphMatcher` is a **stub**
   (`packages/core/src/enrichment/bulk/masterGraphMatcher.ts`).

The deliverable is the design for: (a) the deterministic-first → probabilistic-second matching ladder, (b)
**blocking** as the load-bearing scalability lever, (c) **company-first** resolution and the `master_employment`
edge, (d) the **non-destructive merge** model so rollback = re-derive, (e) the staff **review queue** with
side-by-side merge diff, survivorship preview, and the two-threshold confidence bands, and (f) the
`/api/v1/admin/data/dedup/*` endpoints behind a new `data:review` capability.

> **Guiding principle (02 dim 9):** *bias to false-negatives over Frankenstein merges.* A missed duplicate is a
> recoverable nuisance; a wrong merge corrupts two real entities and erodes trust. When confidence is uncertain,
> route to a human — never auto-merge.

---

## 1. Current Challenges

| # | Challenge | Evidence |
|---|---|---|
| C1 | **Within-ws dedup has no UI.** The dedup worker sets `contacts.duplicate_of_contact_id` (canonical survivor) and tombstones losers, but staff cannot see *why* two contacts merged, cannot review borderline cases, and cannot undo a wrong auto-merge. | `contacts.duplicate_of_contact_id` (`packages/db/src/schema/contacts.ts:103`); dedup queue `enqueueDedup` (`apps/workers/src/register.ts`); `packages/core/src/prospect/dedup.ts` |
| C2 | **Cross-source ER is half-built and inert.** `match_links` carries `match_probability`, `match_method ∈ {deterministic,splink,manual}`, `is_duplicate_of`, and `review_status ∈ {auto,pending,confirmed,rejected}` — but nothing writes `pending`, no Splink producer exists, and `masterGraphMatcher` is a stub. | `packages/db/src/schema/masterGraph.ts:317-348`; `masterGraphMatcher.ts` (STUB) |
| C3 | **No clerical-review console.** The two-threshold (auto-merge / steward-review / auto-reject) D&B Confidence-Code model (02 dim 9) has no operator surface. Borderline matches silently fall to deterministic-only behaviour. | Gap [`03` §5.1](./03-Gap-Analysis.md) |
| C4 | **No merge audit trail / weight decomposition.** When a merge happens there is no record of *which rule fired* or *what the summed match weight was* — so root-cause tooling (02 dim 21, Apollo Duplicate Analyzer) and Splink weight-decomposition audit (02 dim 6) are impossible. | No `match_decisions` table exists |
| C5 | **Merge is effectively destructive at the overlay tier.** Within-ws dedup tombstones the loser; rolling back means resurrecting a `deleted_at` row by hand. There is no non-destructive *re-derive* path (02 dim 12/13). | `contacts.deleted_at` tombstone semantics |
| C6 | **No company-first discipline enforced at the ER boundary.** `master_employment` is the person↔company edge but nothing guarantees the company node is resolved *before* the person is attached (02 dim 7, ZoomInfo Super Six). | `master_employment` (`masterGraph.ts:156`) |
| C7 | **Blocking is undocumented and unmeasured.** ER at scale is `n(n-1)/2` without blocking; no blocking-key strategy or candidate-pair budget is written down, so the system cannot be sized. | Cross-ref [`13` §Blocking](./13-Performance-and-Scaling.md) |

---

## 2. Enterprise Best Practices (cited)

All citations link to [`02-Enterprise-Research`](./02-Enterprise-Research.md). The dimensions load-bearing for
dedup & linking:

- **Dim 5 — Duplicate detection.** Dedup belongs in the **write path**, keyed on stable IDs, returning
  **created-vs-matched** (Apollo `run_dedupe`). **Deterministic-first, probabilistic-second.** Use **blocking**
  (OR-combined strict rules) not all-pairs. **Instrument duplicate *creation*** — ~90% of dupes historically
  came from CRM imports. ([`02` dim 5](./02-Enterprise-Research.md#45-duplicate-detection))
- **Dim 6 — Record linking.** Pairwise matches are **not** entities → build **nodes + edges → connected
  components** (Union-Find/DSU at scale). **Fellegi-Sunter m/u probabilities** → summed **match weights**
  (TF-adjusted for common values). **Weight decomposition is the audit trail** (Splink).
  ([`02` dim 6](./02-Enterprise-Research.md#46-record-linking))
- **Dim 7 — Company↔person relationships.** **Resolve the COMPANY FIRST** (ZoomInfo "Super Six" anchor),
  then attach the person as an **edge** to the company node. **Distrust the company *name*.** Match
  **companies on domain**, **people on email / LinkedIn URL**.
  ([`02` dim 7](./02-Enterprise-Research.md#47-company-person-relationships))
- **Dim 9 — Manual review queues.** **Two thresholds** → three bands: **auto-merge / steward-review /
  auto-reject** (D&B Confidence Code). **Bias to false-negatives over Frankenstein merges.** Run a
  flag → correction-queue-with-SLA → retune loop.
  ([`02` dim 9](./02-Enterprise-Research.md#49-manual-review-queues))
- **Dim 11 — Audit logs.** Attach **source/workflow provenance** to every record; **log match decisions** and
  **record match composition** (D&B MDP). ([`02` dim 11](./02-Enterprise-Research.md#411-audit-logs))
- **Dim 12 — Version history.** The golden record is a **DERIVED, RECOMPUTABLE view** over preserved source
  rows (a "key ring"); version the **resolution rules** too.
  ([`02` dim 12](./02-Enterprise-Research.md#412-version-history))
- **Dim 13 — Rollback.** Make resolution **non-destructive** → roll back a merge by **re-deriving** (vs
  HubSpot's destructive merge). ([`02` dim 13](./02-Enterprise-Research.md#413-rollback-mechanisms))
- **Dim 22 — Scalability.** **BLOCKING is the load-bearing decision** (`n(n-1)/2`; strict OR rules measured
  before run); DSU clustering on a distributed engine.
  ([`02` dim 22](./02-Enterprise-Research.md#422-scalability-strategies)) — see [`13`](./13-Performance-and-Scaling.md).
- **Dim 23 — Performance.** **Normalize BEFORE compare**; deterministic-first then fuzzy on the **residue**;
  **dedupe BEFORE enrichment**. ([`02` dim 23](./02-Enterprise-Research.md#423-performance-optimization))

---

## 3. Gaps in Current Implementation

Linked to [`01-Current-State-Analysis`](./01-Current-State-Analysis.md#53-deduplication--record-linking--partial-deterministic-shipped-er-review-deferred)
and [`03-Gap-Analysis`](./03-Gap-Analysis.md).

| Gap | Current state | Target | Tier |
|---|---|---|---|
| Within-ws dedup review UI | **Shipped** (auto-survivorship, no UI) | Read drill-down on merge decisions; non-destructive undo | **Medium / Phase 1** |
| Cross-source ER clerical queue | **Partial / Inert** (`review_status` enum exists, no `pending` producer) | Steward review queue over `match_links.review_status='pending'` with merge/split | **Medium / Phase 1** |
| Probabilistic scoring (Splink m/u) | **Missing** (`match_probability` column unused) | Fellegi-Sunter scoring producer; weight decomposition stored | **Enterprise / Phase 3+** |
| Match-decision audit / weight decomposition | **Missing** (no `match_decisions` table) | Append-only decision ledger per pair/cluster | **Medium / Phase 1** |
| Non-destructive merge / re-derive rollback | **Partial** (tombstone is destructive-ish) | Key-ring golden record, rollback = re-derive | **Medium / Phase 2** |
| Company-first enforcement | **Partial** (`master_employment` edge exists, order not enforced) | Resolve company → attach person edge | **Medium / Phase 1** |
| Blocking strategy documented & measured | **Missing** | OR-combined blocking keys + candidate budget | **Enterprise / Phase 3+** ([`13`](./13-Performance-and-Scaling.md)) |
| `masterGraphMatcher` | **Stub** | Real overlay→master matcher feeding ER | **Medium / Phase 1** |

---

## 4. Recommended Solution

### 4.1 The two-tier model (keep them separate)

```
┌──────────────────────────────── LAYER-1 OVERLAY (per-workspace, RLS) ────────────────────────────────┐
│  contacts (tenant_id, workspace_id, …)                                                                │
│    └─ duplicate_of_contact_id  ──►  canonical survivor (within THIS workspace only)   [SHIPPED]       │
│       • keyed on email_blind_index (HMAC, uniq_contacts_ws_email) + linkedin_public_id                │
│       • auto-survivorship in the WRITE path (enqueueDedup fan-out on import completed)                 │
│       • SCOPE: never crosses workspace; one customer's dupes are invisible to another                 │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
                                  │  master_person_id (overlay → master link)
                                  ▼
┌──────────────────────────── LAYER-0 MASTER GRAPH (system-owned, NOT RLS) ────────────────────────────┐
│  source_records ──(match_links)──► cluster_id = golden entity id (master_persons / master_companies)   │
│    • match_method: deterministic | splink | manual                                                     │
│    • match_probability: Fellegi-Sunter (Splink)   [column present, producer DEFERRED]                  │
│    • review_status: auto | pending | confirmed | rejected   [queue UI = THIS DOC]                       │
│    • is_duplicate_of: survivor link when two clusters merge (the re-point cascade source)              │
│  master_employment: person ──edge──► company  (is_current, is_primary ≤1/person db-enforced)           │
└───────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Why two tiers.** The overlay tier answers *"is this the same contact inside one customer's workspace?"* and
is RLS-scoped (`withTenantTx`). The master tier answers *"do these `source_records` from many imports/providers
describe the same real-world person/company?"* and is system-owned, read via `withErTx` (role `leadwolf_er`,
no overlay grant, no GUCs — `packages/db/src/client.ts:56`). **Staff cross-tenant ER writes go through
`withPlatformTx`** (audited, BYPASSRLS owner connection, writes a `platform_audit_log` row in the same
transaction — `client.ts:121`). A multi-tenant write without an RLS-enforced or audited path is a bug, not a
style choice.

### 4.2 The matching ladder (deterministic-first → probabilistic-second)

Per **02 dim 23**, normalize *before* compare and run deterministic rules first, reserving fuzzy scoring for the
**residue** that no deterministic rule resolves:

```
STAGE 0  NORMALIZE        lowercase/trim/strip-accents; email → blind index (HMAC); domain → citext;
                          phone → E.164; name → tokenized; LinkedIn → public-id slug
STAGE 1  BLOCK            generate blocking keys; emit candidate PAIRS only within a block (02 dim 22)
STAGE 2  DETERMINISTIC    exact-match strict rules (OR-combined) → match_method='deterministic',
                          review_status='auto', match_probability=NULL          [SHIPPED]
STAGE 3  PROBABILISTIC    Fellegi-Sunter m/u on the residue → summed match weight → match_probability
                          (Splink)                                              [DEFERRED → Phase 3+]
STAGE 4  BAND             apply two thresholds → auto-merge / steward-review (review_status='pending') /
                          auto-reject                                           [queue = THIS DOC]
STAGE 5  CLUSTER          Union-Find / connected components over confirmed edges → cluster_id (02 dim 6)
```

### 4.3 Blocking — the load-bearing scale lever (02 dim 22)

All-pairs comparison is `n(n-1)/2`; at 10M `source_records` that is ~5×10¹³ pairs — infeasible. **Blocking**
restricts comparison to records that share at least one *blocking key*, OR-combined:

| Block key | Entity | Rationale |
|---|---|---|
| `email_blind_index` | person | exact email is the strongest deterministic key |
| `linkedin_public_id` | person | stable identity URL (02 dim 7) |
| `(normalized_last_name, email_domain)` | person | catches email-typo dupes inside a company |
| `account_domain` (citext) | company | companies match on **domain**, not name (02 dim 7) |
| `(soundex(company_name), country)` | company | fuzzy company fallback, never name alone |

A pair enters the candidate set if it shares **any** key (OR). The candidate-pair count per block must be
**measured before a run** and a per-run candidate budget enforced — see
[`13` §Blocking](./13-Performance-and-Scaling.md). Records appearing in no block are singletons (their own
cluster), the common case and the cheap case.

### 4.4 Company-first resolution (02 dim 7)

Resolve the **company node first** (anchor on domain → `master_companies.id`), then attach the person as a
`master_employment` edge (`title`, `is_current`, `is_primary` — db-enforced ≤1 primary per person,
`masterGraph.ts:156`). Distrust the company *name* string entirely; the domain (`accounts.domain` citext,
`uniq_accounts_ws_domain`) is the join key. This ordering is enforced in the matcher: a person edge cannot be
written until its `master_company_id` exists.

### 4.5 Non-destructive merge → rollback = re-derive (02 dim 12/13)

The golden entity (`cluster_id`) is a **derived, recomputable view** over preserved `source_records` (the
key ring is the set of `match_links` rows pointing at the cluster). **Merging two clusters does NOT delete
rows** — it writes `is_duplicate_of` on the loser cluster's links (the re-point source) and records a
`match_decision`. **Rollback = re-derive**: clear `is_duplicate_of`, re-run connected-components, and the two
clusters reappear from their preserved source rows. At the overlay tier, the same discipline replaces the
hard tombstone: `duplicate_of_contact_id` is the non-destructive survivor pointer, and the loser's
`deleted_at` is a DSAR tombstone reserved for compliance deletion, **not** routine merge.

### 4.6 The clerical-review queue (the missing UI — 02 dim 9)

Two thresholds (`T_high`, `T_low`) over `match_probability` produce three bands:

```
match_probability ≥ T_high (e.g. 0.97)  → AUTO-MERGE        review_status='auto'      (no human)
T_low ≤ p < T_high       (e.g. 0.80)     → STEWARD-REVIEW    review_status='pending'   (THIS QUEUE)
match_probability < T_low (e.g. 0.80)    → AUTO-REJECT (keep separate) review_status='rejected'
```

Deterministic exact matches (Stage 2) bypass scoring and land `auto`. Everything the probabilistic stage
scores into the middle band lands in the **pending** queue for a steward to **confirm** (merge), **reject**
(keep separate), or **split** (undo a prior over-merge). **Bias: when in doubt, leave separate.** Thresholds
are configurable per entity type and versioned (02 dim 12 — version the resolution rules).

---

## 5. Implementation Steps (sequenced)

1. **(Phase 1) Add the match-decision ledger.** New table `match_decisions` (the next sequential migration, 0035+) — append-only,
   one row per match decision with the firing rule, summed weight, decomposition jsonb, and reviewer. This is
   the audit trail (02 dim 6/11) and the source for root-cause tooling (02 dim 21).
2. **(Phase 1) Add review-action columns to `match_links`** — `reviewed_by`, `reviewed_at`,
   `review_reason` (alter, same migration, 0035+) so a confirm/reject is attributable.
3. **(Phase 1) Replace the `masterGraphMatcher` stub** with a real overlay→master matcher: normalize → block →
   deterministic. Write `auto` links for exact matches; do **not** yet write `pending` (no scorer).
4. **(Phase 1) Build the clerical-review producer for within-ws borderline dedup.** Where the overlay dedup
   worker today auto-survives, add a borderline band that writes a review row instead of auto-merging when the
   key match is weak (e.g. name+company but no email).
5. **(Phase 1) Add the `data:review` staff capability** (`packages/types/src/staffCapability.ts`) and bundle it
   into `compliance_officer` + `super_admin` in `ROLE_CAPABILITIES`. See [`11`](./11-Roles-and-Permissions.md).
6. **(Phase 1) Build `/api/v1/admin/data/dedup/*` routers** (`review`, `merge`, `split`, `confirm`, `reject`)
   under `apps/api/src/features/admin/`, all writing via `withPlatformTx`.
7. **(Phase 1) Build the admin `features/dedup` feature folder** (review queue + merge diff + survivorship
   preview) following `features/retention` (tabs + super-admin gate). See [`04`](./04-Control-Panel-Architecture.md).
8. **(Phase 2) Wire non-destructive merge** — merge writes `is_duplicate_of` + a `match_decision`; add the
   re-derive rollback path behind `split`.
9. **(Phase 3+) Add the Splink probabilistic scorer** — Fellegi-Sunter m/u weights, TF adjustment, weight
   decomposition stored in `match_decisions.weight_decomposition`; producer fills `match_probability` and bands
   into `pending`. See [`13`](./13-Performance-and-Scaling.md) and [`15`](./15-Future-Enhancements.md).
10. **(Phase 3+) Blocking + DSU at scale** — measured blocking keys, candidate budget, connected-components
    clustering on a distributed engine.

---

## 6. UI/UX Requirements

New admin feature folder `apps/admin/src/features/dedup/` following the `features/retention` template (Tabs +
super-admin/capability gate). Nav: a sub-route under the **Data management** group in
`navConfig.ts` (see [`04`](./04-Control-Panel-Architecture.md)). Components from `@leadwolf/ui` only.

### 6.1 Review queue (list)

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ Dedup & Linking                                          [Within-Workspace] [Cross-Source]  │  ← Tabs
├───────────────────────────────────────────────────────────────────────────────────────────┤
│ Filters:  Entity [person ▾]  Band [steward-review ▾]  Tenant [all ▾]   ⟳ Reload            │  ← Combobox/TpSelect
├───────────────────────────────────────────────────────────────────────────────────────────┤
│ Cluster A            Cluster B            Prob.   Band            Method      Status   ▸     │  ← DataTable
│ Jane Doe (Acme)      Jane Doh (Acme)      0.91    steward-review  splink      pending  ▸     │
│ John Smith (Globex)  J. Smith (Globex)    0.84    steward-review  splink      pending  ▸     │
│ Acme Inc             Acme Incorporated    0.88    steward-review  splink      pending  ▸     │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│ ◀ Prev   [keyset]   Next ▶                                                StatTile: 23 pending│  ← Pagination
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

Components: `Tabs`, `SegmentedControl`, `Combobox`/`TpSelect` filters, `DataTable` + `Column<T>` (sortValue on
probability; rowKey on the candidate-pair id), `StatusBadge` + `StatusTone` for band (pending=warning,
confirmed=success, rejected=neutral), `Pagination` (keyset), `StatTile` for the pending count. Wrapped in
`StateSwitch` for the four states.

### 6.2 Side-by-side merge diff + survivorship preview (drawer)

Clicking a row opens a `Drawer` with a **field-by-field diff** and a **survivorship preview** showing the
*derived* golden record (which source wins each field, per `field_provenance` rules — 02 dim 14):

```
┌──────────────────────── Review match  ·  prob 0.91  ·  splink ───────────────── [×] ┐
│ Field           Cluster A (src import #812)   Cluster B (src enrich PDL)   ► WINNER  │
│ ─────────────── ──────────────────────────── ─────────────────────────── ───────── │
│ Full name       Jane Doe                      Jane Doh                     A (recency)│
│ Email           jane@acme.com   ✓valid        jane@acme.com   ✓valid       = (equal) │
│ Title           VP Sales                       Head of Sales              B (freq×3) │
│ Company         Acme Inc  (acme.com)           Acme  (acme.com)           A (domain) │
│ LinkedIn        /in/janedoe                     —                          A         │
│ Phone           +1 415 …  (mobile)              —                          A         │
│ ─────────────── ──────────────────────────── ─────────────────────────── ───────── │
│ WEIGHT DECOMPOSITION (audit · 02 dim 6)                                               │
│   email exact          +12.4                                                          │
│   company domain match  +6.1                                                          │
│   name jaro-winkler 0.93 +2.0                                                         │
│   title mismatch        −1.8     ──────────  Σ match weight = 18.7  → p=0.91         │
├──────────────────────────────────────────────────────────────────────────────────────┤
│ Justification (required) [ ____________________________________________ ]            │
│            [ Reject (keep separate) ]   [ Split ]   [ Confirm merge ]                 │  ← TpButton
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Components: `Drawer`, `DataTable` (the diff grid), `StatusBadge` (per-field winner reason chip via `TpChip`),
`TpTextarea` for the **mandatory justification reason** (mirror `TenantActions.tsx`), `TpButton` (destructive
tone on Reject/Split, primary on Confirm), `useToast` for the result, `Dialog` confirm on Confirm/Split (these
are high-risk writes). The survivorship preview is **read-only and pre-commit** — it shows what the golden
record *would* derive to, so the steward sees the outcome before committing (preview-then-commit, 02 dim 16 —
see [`09`](./09-Review-and-Approval-System.md)).

### 6.3 Four states (mandatory)

- **Loading** → `LoadingState` / `Skeleton` rows in the `DataTable`.
- **Empty** → `EmptyState` "No matches awaiting review" (the healthy steady state — most matches auto-resolve).
- **Error** → `ErrorState` with `problemMessage(res, fallback)` reading the RFC-7807 detail; `Reload` action.
- **Data** → the queue table + drawer above.

---

## 7. Database & Backend Changes

### 7.1 Reused (no change)

- `match_links` (`packages/db/src/schema/masterGraph.ts:317-348`) — `cluster_id`, `match_probability`
  (numeric(4,3), 0..1 check), `match_method ∈ {deterministic,splink,manual}`, `is_duplicate_of`,
  `review_status ∈ {auto,pending,confirmed,rejected}` (check constraint at `:341`), `idx_match_links_cluster`.
- `contacts.duplicate_of_contact_id` (`contacts.ts:103`) — within-ws survivor pointer (non-destructive).
- `master_employment` (`masterGraph.ts:156`) — person↔company edge; `is_primary ≤1/person` db-enforced.
- `field_provenance` jsonb on `contacts`/`accounts` — per-field winner map driving survivorship preview.
- `platform_audit_log` — written in-tx by `withPlatformTx`.

### 7.2 New table — `match_decisions` (audit trail; migration ~0035)

Append-only ledger; one row per ER/dedup decision. **NOT RLS-scoped** (master-graph tier, system-owned);
written via `withPlatformTx` so the platform audit row is co-written. RLS posture: structurally isolated by db
role/access path (like the rest of Layer-0). UPDATE/DELETE blocked by trigger (mirror `audit_log`,
`billing.ts:169`).

```sql
-- the next sequential migration (0035+) — assigned at implementation time
CREATE TABLE match_decisions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type         varchar(10)  NOT NULL CHECK (entity_type IN ('person','company','contact')),
  -- the two things being compared (cluster ids for master, contact ids for overlay)
  left_ref            uuid NOT NULL,
  right_ref           uuid NOT NULL,
  decision            varchar(16)  NOT NULL
                        CHECK (decision IN ('auto_merge','auto_reject','confirmed','rejected','split')),
  match_method        varchar(20)  NOT NULL
                        CHECK (match_method IN ('deterministic','splink','manual')),
  match_probability   numeric(4,3) CHECK (match_probability IS NULL OR match_probability BETWEEN 0 AND 1),
  match_weight        numeric(8,3),                 -- summed Fellegi-Sunter weight (02 dim 6)
  blocking_key        text,                          -- which OR-key produced the candidate pair
  weight_decomposition jsonb,                        -- [{feature, m, u, weight}] — the audit trail
  rule_version        integer NOT NULL DEFAULT 1,    -- versioned resolution rules (02 dim 12)
  -- attribution
  decided_by          uuid,                          -- platform_staff id (NULL for automated decisions)
  reason              text,                          -- mandatory justification on manual decisions
  tenant_id           uuid,                          -- present for overlay-tier (within-ws) decisions
  workspace_id        uuid,                          -- present for overlay-tier decisions
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_match_decisions_pair ON match_decisions (entity_type, left_ref, right_ref);
CREATE INDEX idx_match_decisions_created ON match_decisions (created_at DESC);

-- block mutation (append-only)
CREATE TRIGGER trg_match_decisions_immutable
  BEFORE UPDATE OR DELETE ON match_decisions
  FOR EACH ROW EXECUTE FUNCTION raise_append_only();   -- reuse the audit_log guard fn
```

### 7.3 New columns on `match_links` (alter; same migration ~0035)

```sql
ALTER TABLE match_links
  ADD COLUMN reviewed_by   uuid,                       -- platform_staff id
  ADD COLUMN reviewed_at   timestamptz,
  ADD COLUMN review_reason text;                       -- mandatory justification echo
```

### 7.4 Tx wrappers & RLS posture

- **Read the queue** (cross-source pending) → `withErTx` (role `leadwolf_er`, reads master graph,
  `client.ts:56`). Overlay-tier within-ws review reads → `withTenantTx(scope, …)` (`client.ts:74`).
- **All review writes** (confirm/merge/split/reject) → **`withPlatformTx(actor, action, fn, {targetType,
  targetId, tenantId, workspaceId, metadata})`** (`client.ts:121`) — owner connection, writes
  `platform_audit_log` **in the same transaction**, only behind a verified `pa` claim. The `match_decision`
  row is written in this same tx. This is the only audited cross-tenant write path.
- High-risk ops (merge across tenants, split a confirmed cluster) additionally require **JIT elevation**
  (`jit_elevations`) and route through the **maker/checker** gate — see [`09`](./09-Review-and-Approval-System.md).

---

## 8. API Requirements

All under `apps/api/src/features/admin/` mounted at `/api/v1/admin/data/dedup/*`. Middleware chain on every
route: `authn` (Bearer-only) → `platformAdmin` (`claims.pa===true`) → `requireStaffRole` (active role
resolved per-request from `platform_staff`) → `requireCapability("data:review")`. Shared Zod from
`@leadwolf/types`, `safeParse` at the edge, responses re-validated with `parse`. RFC 9457 problem envelope
on errors. Scope **always** from the verified token, never the body.

### 8.1 `GET /api/v1/admin/data/dedup/review`

List pending matches (the queue). Keyset pagination (never offset).

```
Query (Zod):   { entityType?: 'person'|'company'|'contact',
                 band?: 'pending'|'auto'|'confirmed'|'rejected',   // default 'pending'
                 tenantId?: uuid,                                  // overlay-tier filter
                 cursor?: string, limit?: number (1..200, default 50) }
Response:      { items: MatchReviewItem[], nextCursor: string|null }
  MatchReviewItem = { id, entityType, leftRef, rightRef, leftSummary, rightSummary,
                      matchProbability|null, matchMethod, reviewStatus,
                      weightDecomposition|null, blockingKey|null, resolvedAt }
Gate:          data:review        Idempotency: n/a (read)
Errors:        401 (no token) · 403 (ForbiddenError, not staff / lacks cap) · 422 (ValidationError)
```

### 8.2 `GET /api/v1/admin/data/dedup/review/:id` — survivorship preview

```
Response:      { item: MatchReviewItem,
                 fieldDiff: [{ field, leftValue, rightValue, winner: 'left'|'right'|'equal',
                              winnerReason: 'recency'|'frequency'|'completeness'|'quality'|'domain'|'source_priority' }],
                 derivedGolden: Record<string, unknown>,        // pre-commit survivorship preview (read-only)
                 decomposition: [{ feature, m, u, weight }] }
Gate:          data:review
Errors:        404 (NotFoundError) · 403 · 401
```

### 8.3 `POST /api/v1/admin/data/dedup/confirm` — confirm a pending match (merge)

```
Body (Zod):    { matchId: uuid, reason: string (min 8) }     // reason MANDATORY
Header:        Idempotency-Key (required — write is replay-guarded)
Effect:        review_status → 'confirmed'; loser cluster links get is_duplicate_of = survivor cluster;
               connected-components re-derive; match_decision(decision='confirmed') written; platform_audit_log
               in-tx (action = 'data.dedup.confirm'); reviewed_by/at/reason set.
Response:      { matchId, clusterId, survivorRef, status: 'confirmed' }
Gate:          data:review (+ JIT elevation + maker/checker for cross-tenant) ; via withPlatformTx
Errors:        409 (already resolved / idempotency replay returns first response) · 422 · 403 · 401
```

### 8.4 `POST /api/v1/admin/data/dedup/merge` — manual merge (steward-initiated, no prior pending row)

```
Body (Zod):    { entityType, leftRef: uuid, rightRef: uuid, reason: string (min 8) }
Header:        Idempotency-Key (required)
Effect:        creates match_method='manual', review_status='confirmed' link + is_duplicate_of re-point +
               match_decision(decision='confirmed', match_method='manual'); withPlatformTx audited.
Response:      { clusterId, survivorRef, status: 'confirmed' }
Gate:          data:review + JIT elevation + maker/checker (high-risk)
Errors:        409 · 422 · 403 · 401
```

### 8.5 `POST /api/v1/admin/data/dedup/reject` — keep separate

```
Body (Zod):    { matchId: uuid, reason: string (min 8) }
Header:        Idempotency-Key (required)
Effect:        review_status → 'rejected'; match_decision(decision='rejected'); the pair is suppressed from
               future auto-merge (negative-evidence rule); platform_audit_log in-tx.
Response:      { matchId, status: 'rejected' }
Gate:          data:review ; via withPlatformTx
Errors:        409 · 422 · 403 · 401
```

### 8.6 `POST /api/v1/admin/data/dedup/split` — non-destructive rollback (re-derive)

```
Body (Zod):    { clusterId: uuid, sourceRecordIds?: uuid[], reason: string (min 8) }
Header:        Idempotency-Key (required)
Effect:        clears is_duplicate_of on the named links; re-runs connected-components so the prior sub-clusters
               re-derive from preserved source_records (NON-DESTRUCTIVE — no row deleted); match_decision(
               decision='split'); platform_audit_log in-tx.
Response:      { clusterId, resultingClusters: uuid[], status: 'split' }
Gate:          data:review + JIT elevation + maker/checker (high-risk, undoes a merge)
Errors:        409 (nothing to split) · 422 · 403 · 401
```

> **Idempotency.** All four write endpoints take `Idempotency-Key` (`middleware/idempotency.ts` +
> `idempotencyRepository`); the db unique is the real guard and replays return the first response including
> failures (02 dim 19).

---

## 9. Edge Cases & Failure Scenarios

| Scenario | Handling |
|---|---|
| **Three-way / transitive merge** (A~B confirmed, B~C confirmed) | Union-Find collapses {A,B,C} into one `cluster_id`; the survivor is the highest-quality node (02 dim 14), not "first seen". |
| **Concurrent confirm on the same pair** (two stewards) | `Idempotency-Key` + db unique; second write replays the first response (409/idempotent), no double-merge. |
| **Confirm after the underlying source_record was DSAR-deleted** | Pre-check `deleted_at`/tombstone; if a side is gone → `409 NotFoundError`, decision is voided, queue row auto-closes. |
| **Cross-tenant overlay merge attempted** | Overlay dedup **never** crosses workspace; a `tenantId` mismatch is rejected `422`. Cross-source ER is master-tier and tenant-agnostic by construction. |
| **Splink scores a pair into the middle band but company is unresolved** | Company-first guard: defer the person decision until `master_company_id` exists (02 dim 7); hold in `pending` with reason `company_unresolved`. |
| **Frankenstein-merge risk** (high name+title similarity, different email domain) | Bias to false-negative (02 dim 9) → `auto_reject` or `pending`, never `auto_merge`; email-domain mismatch is strong negative evidence in the weight decomposition. |
| **Rollback of a merge whose loser was edited post-merge** | Re-derive uses preserved `source_records` (key ring); post-merge edits to the golden view are recomputed, not lost — golden record is DERIVED (02 dim 12). |
| **Blocking misses a true dup** (no shared key) | Accepted false-negative; periodic relaxed-blocking sweep (Phase 3+) widens recall; see [`13`](./13-Performance-and-Scaling.md). |
| **Idempotency replay of a `split` after re-derive changed the graph** | First response replayed verbatim; graph is already in target state, no double-split. |
| **Reviewer lacks JIT elevation on a cross-tenant merge** | `403 ForbiddenError` with detail pointing to the elevation request flow; the maker/checker gate holds the write. |

---

## 10. Testing Strategy

- **Unit (`packages/core`).** Normalization (Stage 0), blocking-key generation (each OR key), deterministic
  rule firing, band assignment given `(T_low, T_high)`, Union-Find/connected-components over a fixture graph
  (transitive merge, split re-derive), survivorship winner selection per `field_provenance` rule.
- **Unit (matcher).** `masterGraphMatcher` real impl: company-first ordering (person edge refused until company
  resolved), deterministic-vs-residue routing.
- **Integration (`apps/api`).** Each `/dedup/*` endpoint: middleware chain (401/403 without
  `data:review`), Zod `safeParse` 422 on bad body, mandatory-reason enforcement, idempotency replay (same key →
  first response), `match_decision` + `platform_audit_log` co-written in one tx (assert both rows or neither).
- **itest — mandatory tenant-isolation test (writes data).** Per the read-first rule, any path that writes must
  prove isolation: (a) overlay dedup **cannot** merge contacts across two workspaces (attempt → rejected); (b) a
  `withPlatformTx` merge writes the `platform_audit_log` row with the correct actor and is visible only via the
  audited path; (c) `withErTx` reads of the queue carry no overlay grant. Assert RLS fail-closed (NULLIF empty
  scope → no rows).
- **itest — non-destructive rollback.** Merge A+B → split → assert A and B re-derive identically from preserved
  `source_records` (no row deleted, `match_decision` records both the merge and the split).
- **Regression.** Frankenstein guard: a fixture pair with matching name/title but mismatched email domain must
  land `pending`/`rejected`, never `auto_merge`.

---

## 11. Rollout & Migration Plan

| Stage | Gate | Behaviour |
|---|---|---|
| **Next migration (0035+)** | — | Add `match_decisions` + `match_links.reviewed_*` columns. Backfill: none (existing `auto` links keep `review_status='auto'`; no `match_decision` rows are synthesized retroactively). |
| **Capability** | add `data:review` to `staffCapability.ts`; bundle into `compliance_officer` + `super_admin` | Closed enum grows 16→17 (one of four total `data:*` additions; the enum reaches 20 — see [`11`](./11-Roles-and-Permissions.md)); `capabilitiesForRole()` updated. See [`11`](./11-Roles-and-Permissions.md). |
| **Shadow** | `masterGraphMatcher` real impl writes `auto` deterministic links only; no `pending` produced | ER continues deterministic-only; queue UI ships but shows the (empty) pending band. No behaviour change. |
| **Canary** | enable the within-ws borderline producer for 1–2 pilot tenants | Borderline overlay dedups route to `pending` instead of auto-survive; stewards work the queue; measure false-positive/negative rate vs labelled set (02 dim 20). |
| **GA** | enable the queue producer fleet-wide | Steward-review band active for overlay tier. |
| **Phase 3+** | add Splink scorer behind a flag; fill `match_probability`; band into `pending` | Probabilistic tail goes live; thresholds tuned on labelled data; weight decomposition stored. See [`13`](./13-Performance-and-Scaling.md), [`15`](./15-Future-Enhancements.md). |

Rollback of the rollout itself: the producer is flag-gated; disabling it reverts to deterministic-only `auto`
behaviour with zero data loss (decisions already made are preserved, append-only).

---

## 12. Success Metrics & Acceptance Criteria

**Metrics (02 dim 20).** Per-band volume (auto/pending/rejected); steward throughput & queue age (SLA); merge
false-positive and false-negative rate vs a labelled set; duplicate-creation provenance (which import/provider
spawns dupes — 02 dim 5); split (rollback) rate as an over-merge signal.

**Acceptance criteria (testable checklist):**

- [ ] `match_decisions` table + `match_links.reviewed_*` columns shipped in the next sequential migration (0035+); UPDATE/DELETE on
      `match_decisions` blocked by trigger.
- [ ] `data:review` capability added to the closed enum and bundled into `compliance_officer` + `super_admin`;
      a `read_only` staff member gets `403` on every `/dedup/*` write.
- [ ] `masterGraphMatcher` stub replaced; deterministic links write `match_method='deterministic'`,
      `review_status='auto'`, `match_probability=NULL`.
- [ ] `GET /dedup/review` returns the `pending` band with keyset pagination (`nextCursor`), filterable by
      entity/band/tenant.
- [ ] `GET /dedup/review/:id` returns the field diff + **read-only derived survivorship preview** + weight
      decomposition before any commit.
- [ ] `confirm`/`merge`/`split`/`reject` each require a mandatory `reason` (min 8) and an `Idempotency-Key`;
      replay returns the first response.
- [ ] Every `/dedup/*` write goes through `withPlatformTx` and co-writes a `platform_audit_log` row **in the
      same transaction** (assert both-or-neither).
- [ ] Merge is **non-destructive**: confirm sets `is_duplicate_of` (no row deleted); `split` re-derives the
      original clusters from preserved `source_records`.
- [ ] **Tenant-isolation itest passes:** overlay dedup cannot merge across workspaces; `withErTx` reads carry no
      overlay grant; RLS fail-closed on empty scope.
- [ ] **Frankenstein guard:** a name+title match with mismatched email domain never `auto_merge`s.
- [ ] Company-first: a person edge is never written before its `master_company_id` is resolved.
- [ ] Four UI states (loading/empty/error/data) implemented via `StateSwitch`; merge diff + survivorship preview
      render in a `Drawer` with mandatory-justification `TpTextarea` and `Dialog` confirm on high-risk actions.

---

### Cross-references

[`01-Current-State-Analysis`](./01-Current-State-Analysis.md#53-deduplication--record-linking--partial-deterministic-shipped-er-review-deferred) ·
[`02-Enterprise-Research`](./02-Enterprise-Research.md) ·
[`03-Gap-Analysis`](./03-Gap-Analysis.md) ·
[`04-Control-Panel-Architecture`](./04-Control-Panel-Architecture.md) ·
[`05-Upload-Pipeline-Design`](./05-Upload-Pipeline-Design.md) ·
[`06-Data-Validation-Framework`](./06-Data-Validation-Framework.md) ·
[`08-Data-Enrichment-Workflow`](./08-Data-Enrichment-Workflow.md) ·
[`09-Review-and-Approval-System`](./09-Review-and-Approval-System.md) ·
[`10-Monitoring-and-Observability`](./10-Monitoring-and-Observability.md) ·
[`11-Roles-and-Permissions`](./11-Roles-and-Permissions.md) ·
[`12-Security-and-Compliance`](./12-Security-and-Compliance.md) ·
[`13-Performance-and-Scaling`](./13-Performance-and-Scaling.md) ·
[`14-Implementation-Roadmap`](./14-Implementation-Roadmap.md) ·
[`15-Future-Enhancements`](./15-Future-Enhancements.md)
