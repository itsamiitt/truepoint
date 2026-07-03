# 04 — Contact Schema Design

> **Status of this doc:** 🟡 drafted (design doc — target state for the `contacts` overlay table,
> its identity/dedup semantics, and the customer-facing merge contract).
> **Evidence base:** [`01-Current-State-Audit.md`](01-Current-State-Audit.md) (as-is, `file:line`),
> [`02-Root-Cause-and-Gap-Analysis.md`](02-Root-Cause-and-Gap-Analysis.md) (gap register),
> [`03-Enterprise-Research.md`](03-Enterprise-Research.md) (all external-platform claims, cited as
> `03 §n [nn]`).
> **Gaps owned here:** **G20** (true merge — the merge contract), **G19 ◇** (employment-history
> disposition), plus the contact-core semantics that G15/G21 build on. Sibling doc
> [`05`](05-Multi-Value-Channel-Architecture.md) owns the `contact_emails`/`contact_phones`
> child-table spec; this doc must stay consistent with it and never re-specs it.
> **Migration references are step IDs** (`S-C1`…); doc `15` sequences them — never fixed numbers.

---

## Objective

Design the target state of the **`contacts` overlay row** — the per-workspace, RLS-scoped record
of a person (`packages/db/src/schema/contacts.ts:103–238`) — so that:

1. the flat encrypted email/phone columns become the **permanent denormalized primary-value
   cache** over doc 05's multi-value channel tables (the industry dual shape, 03 §3.3 [41][44][10]);
2. the three shipped partial-unique dedup keys remain the **primary identity contract**, with
   secondary channel values participating in match-time dedup without ever becoming uniqueness
   constraints on `contacts`;
3. a **customer-facing true merge** exists for the first time (G20): field union through the
   canonical `planFieldWrite` pin machinery, a complete child-record re-pointing inventory, a
   loser tombstone, and irreversibility guardrails instead of unmerge;
4. field-level change history (G22 ◇) and employment history (G19 ◇) get an explicit disposition
   — what ships adjacent, what is deferred, and why.

This doc changes the **overlay layer only**. Layer-0 (`master_*`) is untouched.

---

## Reconciliation (what this design builds on and does not change)

Per the series README, this section pins the design to shipped code and locked decisions.

**Shipped code this extends** (all verified in 01 §6):

- The `contacts` table as it exists — flat encrypted channels (`email_enc`/`email_blind_index`/
  `email_domain`/`email_status`, `phone_enc`/`phone_status`/`phone_line_type`,
  `contacts.ts:120–136`); three per-workspace partial uniques (`contacts.ts:187–195`); soft
  owner `owner_user_id` as a filter dimension (`contacts.ts:113–117`); reveal-invariant CHECKs
  (`contacts.ts:213–217`); `deleted_at` DSAR tombstone (`contacts.ts:165`); `custom_fields` +
  `field_provenance` jsonb (`contacts.ts:168,171`).
- The canonical provenance machinery: the winner-map descriptor
  (`packages/types/src/fieldProvenance.ts:19–45`), the pure merge planners `planFieldWrite` /
  `planUserEdit` (`packages/core/src/prospect/fieldProvenance.ts:40–80`), the hand-edit setter
  (`packages/core/src/prospect/editContact.ts`), and the seven pin-protected scalar fields
  (`CONTACT_PROVENANCE_FIELDS`, `fieldProvenance.ts:54–62`).
- The marker-only dedup layers: the automated sweep (`packages/core/src/prospect/dedup.ts`,
  writes only `duplicate_of_contact_id`) and the staff grain-A `execDedupMerge`
  (`packages/db/src/repositories/platformAdminWrites.ts:339–364` — the same marker, maker-checker,
  explicit tenant+workspace predicates, cycle-guarded, "NO master-graph write").
- The bulk-mutation isolation guard `contactRepository.visibleContactIds`
  (`contactRepository.ts:767–774`) and the append-only `audit_log` with its closed action enum
  (`packages/db/src/schema/billing.ts:214–255`).

**Locked decisions that bind this doc:**

- **DM1** — one canonical primitive set; the merge contract *reuses* `planFieldWrite`/
  `planUserEdit`, never a second implementation (`../data-management/00-overview.md` §3).
- **DM4** — tenancy unchanged: two-tier `tenant_id`/`workspace_id`, overlay RLS on the
  fail-closed workspace GUC; within-workspace owner scope stays an **app-layer soft filter**.
  No user GUC is introduced here (doc 10's constraint, 01 §5.1).
- **DM6** — provenance is the one jsonb winner-map; `pin=true` blocks overwrite. The merge
  contract is expressed *through* it.
- **ADR-0028** — custom fields stay values-in-jsonb (100M-row rationale, 01 §6.7). No EAV, no
  custom-field child table is proposed here.
- **`data-management/15-bulk-import-design.md` §rationale** — the pin-aware overwrite rule lives
  in canonical TS (`planFieldWrite`) and is **never re-expressed as SQL** `CASE` over
  `field_provenance`; the three-partial-unique identity ladder cannot ride a single
  `ON CONFLICT`. Both facts shape the merge engine below.

**What this doc explicitly does NOT change:**

- Tenancy and RLS (DM4). Visibility/permissions are doc `10`'s domain — `owner_user_id` stays
  filter-only here; nothing in this doc turns ownership into an access wall.
- Layer-0. `master_persons` / `master_employment` / `master_emails` / `master_phones` and the
  `withErTx` access path are untouched; grain-B cluster merge stays security-review-gated
  (01 §6.9). The overlay merge below never writes the master graph.
- The custom-field mechanism (ADR-0028).
- The three dedup partial uniques as **primary identity** (`contacts.ts:187–195`) — retained
  verbatim; §2 below only adds match-time participation of secondary values.
- The `contact_emails`/`contact_phones` internals — doc 05 owns their columns, uniques, RLS,
  and encryption; this doc consumes them as a contract ("see 05 §child-table spec").

---

## Current Challenges (summary — the as-is is 01)

- One email, one phone per contact; enrichment and imports discard additional verified channel
  values (01 §6.2, RC-4).
- Nothing merges: markers accumulate (`duplicate_of_contact_id`), the grain-A executor annotates
  without moving a value, children are never re-pointed, there is no loser tombstone semantics
  beyond DSAR soft-delete (01 §6.9, RC-5).
- No field-level before/after history — `field_provenance` holds only the current winner
  (01 §6.10).
- Employment is a flat `account_id` + denormalized `job_title`; a job change silently overwrites
  (01 §6.6).

## Enterprise Best Practices (cited)

- **Dual channel shape** — child value objects *alongside* a retained flat primary cache:
  Salesforce runs `ContactPointPhone`/`ContactPointEmail` next to the classic flat `Contact`
  columns (03 §3.1 [41][44]); HubSpot runs one primary + computed overflow (03 §3.1 [10]).
  Exactly-one-primary is the load-bearing invariant; promotion is an atomic swap (03 §3.3 [10][13][25]).
- **Merge execution** — chosen-survivor wins, loser fills blanks, per-field override before
  confirm (03 §2.1 [9][70]); children always union onto the survivor, survivor keeps its ID,
  loser is soft-deleted (03 §2.1 [40][81][87]); **type-aware demotion**: a losing email becomes a
  *secondary* email, never discarded (03 §2.1 [9]).
- **Irreversibility** — unmerge exists nowhere; the market ships guardrails instead: never
  auto-merge, side-by-side review, small per-operation caps (3-at-a-time [70]), lifetime caps
  (250 [9]), audit events (Attio `record.merged` [89]) (03 §2.1, §2.3).
- **Match vs act split** — Salesforce separates Matching Rules (define a duplicate) from
  Duplicate Rules (what to do about it) (03 §2.1 [34]); bulk/import paths never row-block on
  duplicates — detection routes to a persistent review queue (03 §2.3 [34][8]).
- **Stable per-value identity** — RFC 9553 makes per-value map keys normatively stable; merge
  executors re-point/tombstone by id, never rewrite in place (03 §7 [123]).

## Gaps (register pointers — evidence in 01, linkage in 02)

| Gap | This doc's role |
|---|---|
| **G20** (P1) | Owner — the merge contract (§3) |
| **G19 ◇** (P2) | Owner — employment-history disposition (§5) |
| **G22 ◇** (P2) | Disposition recorded here (§4); final ownership stays with `14 §future` / `07` per the register |
| G15 (P0) | Consumer — doc 05 owns the child tables; §1/§2 define the cache + identity contract they plug into |
| G21 (P2) | Semantics defined here (§3.5); the review surface is doc 11's |
| G13 (P2) | The `planFieldWrite` strategy layer §3.2 relies on; the import-facing triad is doc 08's |
| G18 (P1) | Dependency — account merge-loser tombstones need `accounts.deleted_at` (doc 06) |
| G23 ◇ (P2) | `record_tags` re-pointing handled in §3.4; the FK question stays doc 07's |

---

## Recommended Solution

### §1 Target `contacts` table — column-by-column disposition

Dispositions: **keep** (unchanged) · **keep-as-primary-cache** (retained permanently; semantics
re-scoped to "denormalized cache of the primary child row") · **add** · **deprecate-never-drop**.
No column is dropped by this series.

| Column(s) (`contacts.ts`) | Disposition | Target semantics |
|---|---|---|
| `id`, `tenant_id`, `workspace_id` | keep | DM4 unchanged; `id` is the stable record identity the survivor keeps on merge (03 §2.1 [40]) |
| `account_id` | keep | Flat current-employer pointer; **no SCD2 in the overlay** (§5). Merge: survivor keeps its own; blank fills from loser |
| `master_person_id` | keep | Layer-0 bridge, re-pointable, never cascade (01 §6.1). Merge never writes the master graph; the loser's bridge rides the tombstone (§3.6) |
| `owner_user_id` | keep | **Filter-only** (01 §6.4); anything stronger is doc `10`'s domain. Merge: survivor's owner wins; blank fills from loser |
| `first_name`, `last_name`, `job_title`, `seniority_level`, `department`, `location_country`, `location_city` | keep | The seven pin-protected hand-editable scalars (`CONTACT_PROVENANCE_FIELDS`); merge writes them only through `planFieldWrite`/`planUserEdit` (§3.2) |
| `email_enc`, `email_blind_index`, `email_domain`, `email_status` | **keep-as-primary-cache** | Permanently retained; value = the `is_primary` row of `contact_emails` (05 §child-table spec). Written **only** by the channel write path in the same tx as the child row (§3.3, pre-build §SoT). Search facets, the dedup unique, and the COPY-staging encoder keep binding to these columns unchanged |
| `phone_enc`, `phone_status`, `phone_line_type` | **keep-as-primary-cache** | Same contract over `contact_phones` (05 §). `phone_line_type` stays the TCPA gating signal cached from the primary row |
| `linkedin_url`, `linkedin_public_id`, `sales_nav_profile_url`, `sales_nav_lead_id` | keep | Single-value identity keys (not channels — one profile per person per network); two of them are dedup uniques (§2) |
| `is_revealed`, `revealed_by_user_id`, `revealed_at` + CHECKs | keep | Reveal invariants unchanged; merge's reveal-state rule in §3.4 (billing-sensitive) |
| `last_verified_at`, `jurisdiction`, `region`, `last_activity_at`, `priority_score`, `outreach_status`, `pipeline_stage_id` | keep | Merge: survivor wins; `last_activity_at` = max(survivor, loser); `priority_score` recomputes on next scoring pass |
| `duplicate_of_contact_id` | keep | Stays the **reversible suggestion marker** (automated sweep + grain-A). Never overloaded to mean "merged" — see `merged_into_contact_id` |
| `deleted_at` | keep | Soft-delete stays; gains one extra producer: the merge-loser tombstone (§3.4). DSAR semantics unchanged |
| `custom_fields` (jsonb, ADR-0028) | keep | Merge union: survivor's keys win, loser fills absent keys (shallow, mirroring the shipped `existing ‖ incoming` write semantics, 01 §6.7) |
| `field_provenance` (jsonb, DM6) | keep | The merge's decision substrate (§3.2); loser's map is preserved verbatim inside the merge audit event |
| `created_at`, `updated_at` | keep | — |
| **`merged_into_contact_id`** (uuid, self-FK, nullable) | **add** (S-C1) | Set on the loser at merge commit; the irreversible supersession pointer, distinct from the reversible marker. Partial index `WHERE merged_into_contact_id IS NOT NULL` |
| **`merged_at`** (timestamptz, nullable) | **add** (S-C1) | Merge commit time on the loser; the actor lives in the audit event, not a column |

**Why a new pointer instead of reusing `duplicate_of_contact_id`:** the marker is a *suggestion*
— reversible, customer-unmarkable, written by an automated sweep (01 §6.9). Merge is an
*executed, irreversible* state (03 §2.1 [9][40][87]). Overloading one column would make "undo the
suggestion" and "undo the merge" the same write, and the second must not exist. Two columns keep
the two state machines honest; a merged loser carries both (`duplicate_of` may remain as history,
`merged_into` is authoritative).

**Deprecate-never-drop:** none in v1. The flat channel columns are explicitly **not** deprecated
— they are re-scoped to cache and kept forever (program-brief spine; Salesforce has never dropped
its flat columns either, 03 §3.1 [44]).

### §2 Identity & the dedup ladder — primary keys vs match-time keys

**Primary identity (unchanged, load-bearing):** the three per-workspace partial uniques —
`(workspace_id, email_blind_index)`, `(workspace_id, linkedin_public_id)`,
`(workspace_id, sales_nav_lead_id)` (`contacts.ts:187–195`) — remain the only uniqueness
constraints on `contacts` and the only upsert targets for imports. The precedence
email → linkedin → sales-nav is shared by sync import, bulk staging `identity_key`, and
`findByDedupKeys` (01 §6.3) and does not change. The email unique **on `contacts`** binds to the
**primary-cache** blind index (the constraint HubSpot's model also carries — dedup on the primary;
03 §2.1 [8]) and it is what keeps the shipped import `ON CONFLICT` machinery valid; the match
*rung* itself widens to every live email value, whose workspace-wide uniqueness lives on the
child table (05 §2.2).

**Secondary values never become uniqueness constraints on `contacts`.** Doc 05's child rows carry
their own value uniqueness inside the child tables (per-workspace for emails, per-contact for
phones — 05 §2.2); `contacts` gains no new unique. Following the Salesforce match-vs-act split
(03 §2.1 [34]) and the canonical email+record-ID key hierarchy (03 §2.1 [8]):

- **Match layer (extended):** the email rung's lookup widens from the flat column to **every live
  `contact_emails` row** (05 §6) — still a deterministic identity rung, because 05's per-workspace
  value unique guarantees any email value resolves to at most one live contact; a hit on *any*
  email value (primary or secondary) keeps today's behavior (upsert per `conflictPolicy`). The
  ladder additionally gains a **phone E.164 probe** against `contact_phones` (DM5 already names
  E.164 in the canonical ladder) — a match *signal* only, never an upsert target (shared
  HQ/switchboard lines are legal; phone is a dedup key nowhere in the market — 05 §2.2).
- **Act layer:** a phone-signal-only match — or 05 §2.2's cross-key conflict (a row matched to
  contact A by a stronger key while carrying an email that lives on contact B) — never silently
  updates or blocks a row (bulk paths never row-block on duplicates, 03 §2.3 [34]). The row lands
  per policy and the existing `duplicate_of_contact_id` marker is written toward the signalled
  contact, feeding the review queue (G21; surface in doc 11, "N potential duplicates" rollup per
  import in doc 08).

This preserves the shipped invariant that one upsert cannot express conflict-on-any-of-N keys
(`data-management/15` §rationale) — the primaries stay the only conflict targets; everything
else routes through markers and (now) merge.

### §3 The merge contract (owns G20)

The first customer-facing **true merge**: field union + child re-pointing + loser tombstone, in
one RLS-scoped transaction. Prerequisites: doc 05's channel tables (type-aware demotion needs
somewhere to demote *to* — 03 §2.3 [9]) and, for the account sibling, doc 06's
`accounts.deleted_at` (G18). Sequenced after both in doc 14.

#### §3.1 Verb, gates, guardrails

- `POST /api/v1/contacts/:id/merge` — survivor = `:id`; body carries `loserContactId` + the
  per-field decision set from the review step. Idempotency-Key required (API contract,
  truepoint-platform). **Two records per operation** in v1 (below Salesforce's 3 [70] — start
  tighter, relax later); per-workspace daily merge cap (FinOps-style brake; cap value is a
  doc 14 rollout knob).
- **Never auto-merge.** The automated sweep and grain-A stay marker-only *suggestion sources*
  (03 §2.3); merge always passes a human through a side-by-side review (doc 11).
- Role gate: org `admin`/`owner` by default, org-configurable down to `member` — the exact
  grant matrix is doc `10`'s (same family as its import-permission grant, 03 §5.1 [17]). Both
  ids are validated live-in-workspace via `visibleContactIds` in the same tx (IDOR guard).
- Dual-gated dark rollout: env `CONTACT_MERGE_ENABLED` + per-tenant `contact_merge_enabled`
  flag (the shipped dual-gate pattern, 01 §7.3) — S-C3.

#### §3.2 Survivor selection & field-level winner rules — through `planFieldWrite`, never SQL

- **Survivor:** user-chosen in the review UI. Default preselection = the marker's canonical
  target when merging from a `duplicate_of_contact_id` suggestion; otherwise the older row
  (creation-order heuristic, 03 §2.1 [8]). The survivor keeps its `id` — every external
  reference (list URLs, API consumers) stays valid (03 §2.1 [40]).
- **Default rule:** survivor's populated value wins; loser fills blanks; user overrides
  per-field before confirm (03 §2.1 [9][70]).
- **Mechanics (canonical, DM1/DM6):** the merge engine computes the loser-sourced field set
  (blanks-to-fill ∪ user picks of the loser's value) and plans it with
  `planFieldWrite(survivorProvenance, fields, { src: "merge", obs: mergedAtIso })` — so a
  **pinned survivor field is structurally unoverwritable** even if the UI misbehaves
  (`fieldProvenance.ts:48–53`). A user's explicit per-field pick is a human assertion and runs
  through `planUserEdit` (sets `pin:true`), consistent with `editContact.ts`. Per
  `data-management/15` §rationale, none of this is re-expressed as SQL `CASE` — the executor
  calls the pure planners and persists the result in the tx.
- `custom_fields`: shallow union, survivor-wins per key (§1). `field_provenance` of the loser is
  never merged into the survivor's map (descriptors describe the survivor's *current* values);
  it is preserved in the audit event payload instead (§4).

#### §3.3 Type-aware channel demotion (the RC-4 → RC-5 dependency, resolved)

The loser's channel values are **never discarded** (03 §2.1 [9]):

- All of the loser's `contact_emails`/`contact_phones` rows re-point to the survivor as
  **secondary** rows (`is_primary = false`) — the survivor's primary is untouched, so the
  primary-value cache columns on the survivor **do not change** and no cache rewrite is needed
  unless the user explicitly promotes a loser value (which is then 05's atomic
  primary-swap, cache maintained in the same tx).
- Value collisions (loser's row equals a survivor row by blind index) collapse into the
  survivor's existing row under the child table's **per-contact** value unique (05 §2.2); the
  richer verification state wins per 05's row-merge rule.
- Pre-child-tables there is nothing to demote *to* — which is why G20 sequences after G15
  (02 §RC-5). The merge flag stays off until 05's tables are live.

#### §3.4 Child-record re-pointing inventory

All in the **same `withTenantTx`** as the field writes (atomicity — pre-build §failure-modes).
Two classes:

**Class A — live operational rows: re-point to the survivor.**

| Table (verified FK) | Re-point rule |
|---|---|
| `contact_emails` / `contact_phones` (05 §) | §3.3 — demote to secondary; collapse collisions |
| `list_members` (`lists.ts:92–94`, unique `(list_id, contact_id)` at `:108`) | `UPDATE … SET contact_id = survivor` with per-row conflict-skip — a list holding both keeps one membership (union, 03 §2.1 [40]); the loser's `added_via`/`source_import_id` provenance rides the surviving row only when the survivor had none |
| `source_imports` (`contacts.ts:249–251`) | Re-point (lineage follows the person). `(workspace_id, content_hash)` unique collisions are impossible across distinct rows (hash includes row content) but the update still runs conflict-tolerant |
| `activities` (`activity.ts:29–31`) | Re-point wholesale — the survivor's timeline becomes the union (03 §2.1 [40]) |
| `record_tags` (`tags.ts:48+`, bare uuid — G23 ◇) | Re-point by `(entity='contact', record_id=loser)`, dedupe against survivor's existing tag set. The missing-FK integrity question stays doc 07's |
| `contact_reveals` (`billing.ts:39,45`) | Re-point per reveal_type, conflict-skip when the survivor already holds the same claim. **Merge never creates a billable event and never double-charges** — claims move, they are not re-minted |
| `suppression_list` rows with `match_type='contact_id'` (`billing.ts:156,167`) | Re-point — suppression is unbypassable (DM7); a suppressed loser must keep suppressing the merged record |
| `consent_records` (`compliance.ts:15,25`) | Re-point — consent history follows the person |
| `outreach_log` (`outreach.ts:92`), `email_thread`/`email_message`/`email_event` (`email.ts`), `sales_nav_links` (`salesnav.ts:37`), `scores`/`intent_signals` (`intel.ts:35`) | Re-point; `scores`: keep both histories, survivor's `priority_score` cache recomputes next pass |

**Class B — historical/job ledgers: never rewritten.** `import_job_rows` audit pointers (no FKs
by design, `importJobs.ts:144–146`), `enrichment_job_rows.matched_contact_id`,
`reveal_job_rows.contact_id`, `provider_calls` — these are point-in-time records of what a job
did; rewriting them would falsify history. They keep pointing at the loser, whose tombstone's
`merged_into_contact_id` provides the traversal hop. Because the loser is **soft**-deleted, no
FK breaks (nothing cascades).

**Reveal state on the survivor:** if the loser is revealed and the survivor is not, the survivor
adopts the loser's reveal trio (`is_revealed`/`revealed_by_user_id`/`revealed_at` — the CHECKs
at `contacts.ts:213–217` are satisfied as a unit); if both are revealed, the survivor keeps its
own (first-reveal-wins posture preserved).

**Loser tombstone:** `deleted_at = now()`, `merged_into_contact_id = survivor`,
`merged_at = now()`, and PII columns nulled — safe because every channel value now lives on the
survivor's child rows; this keeps exactly one tombstone semantic in the table (the DSAR posture,
`contacts.ts:165`). Other rows' markers pointing *at* the loser
(`duplicate_of_contact_id = loser`) are re-pointed to the survivor in the same tx (no dangling
suggestions).

#### §3.5 Interaction with the marker layers and grain-A (supersession path)

- The **automated sweep** (`prospect/dedup.ts`) is unchanged — it remains the suggestion
  producer; its markers + I5 `match_links` become the input queue for the review surface
  (G21, doc 11), matching the persistent-queue market pattern (03 §2.1 [34][8]).
- The **grain-A `dedup_merge` executor** is superseded *for value-moving* but not removed: it
  keeps its shipped marker-only semantics (a staff annotation verb). When staff need a true
  merge on a tenant's behalf, the Surface-1 path wraps **the same core merge engine** under the
  existing maker-checker approval flow — one merge implementation (DM1), two entry surfaces
  (two-surface rule). The executor is never extended to move values itself; its code comment's
  deferral of grain-B stands.
- **Grain-B** (master-cluster merge/split) remains security-review-gated and out of scope; the
  overlay merge is complete without it because the master bridge is nullable and re-pointable
  (01 §6.1).

#### §3.6 Irreversibility posture

Merge is irreversible on every surveyed platform ("unmerge exists nowhere", 03 §2.1 [9][40][87])
— TruePoint ships **guardrails, not unmerge**: human-only side-by-side review, 2-record cap,
daily cap, dual-gate flag, pinned-field immunity, the audit event below, and the tombstone
retaining `merged_into` + the loser's full pre-merge state in the audit payload. A *manual*
reconstruction remains possible for support (re-create from `source_imports` provenance + the
audit before/after) — a runbook, not a product verb (Salesforce's recycle-bin husk teaches that
a half-restore is worse than none, 03 §8 caveat 4).

### §4 Field-level change history — G22 ◇ disposition

**Recommendation: the in-tx audit-log approach; full temporal tables deferred** (the register
keeps final ownership with `14 §future`, recorded in `07`).

- Every write to the seven hand-editable scalars (`editContactFields`) and every merge writes an
  `audit_log` row **in the same transaction** as the mutation (pre-build §audit: in-tx, not
  fire-and-forget), with structured `metadata`: `{ fields: { <name>: { b, a } }, src }` —
  before/after for the changed scalars only. These are the clear-text overlay columns (names,
  title, location — never `email_enc`/`phone_enc` values; channel history is structural in 05's
  child rows, which soft-delete rather than rewrite, giving per-value history for free per the
  stable-id principle, 03 §7 [123]).
- The merge event is a new closed-enum action **`contact.merge`** (S-C2 extends the CHECK at
  `billing.ts:232–255` and the `auditAction` source enum in `@leadwolf/types`), whose metadata
  carries: survivor id, loser id, the per-field decision set, the loser's `field_provenance`
  map, and the re-point counts per child table — enough for support to reconstruct the merge
  from audit data alone.
- **Rejected for now:** overlay SCD2/temporal tables for all fields — the row-versioning cost at
  the 100M-row design point (the ADR-0028 rationale family) buys little beyond the ~7
  hand-editable fields + merge events, and vendors' absent history is a *documented* failure
  mode only for domains (03 §4.1 [15][26]), which doc 06 handles structurally. If a compliance
  driver later demands full history, it lands as a new adjacent subsystem (doc 14 §future),
  not a rewrite of this contract.

### §5 Employment history — G19 ◇ disposition

**Recommendation: AGAINST overlay SCD2 now.** The overlay keeps the flat `account_id` +
denormalized `job_title` (pin-protectable); truth for stints stays Layer-0 `master_employment`
SCD2 (`masterGraph.ts:149–156`, 01 §6.6).

- No surveyed CRM ships overlay stint history (02 §G19); replicating SCD2 into every workspace
  would duplicate Layer-0's job at N× the storage and create an overlay↔master reconciliation
  problem DM4's boundary exists to avoid.
- The future path is the **knowledge-DB projection**
  (`../prospect-database-platform/05-Internal-Knowledge-Database.md`) — read-only intelligence
  ("changed jobs" signals, past-stint display) *fed* to the overlay as suggestions, never
  absorbed as overlay writes (the series README pins it as feeder, not replacement).
- What ships now instead: a job change arriving via import/enrichment is a normal
  `planFieldWrite` against `job_title`/`account_id` (pin blocks it if hand-edited), and §4's
  audit metadata preserves the before/after — so "what was their title in March" is answerable
  from audit even without stint rows.

### §6 Zod contract evolution in `@leadwolf/types` (shapes only)

- **`maskedContactSchema`** (`packages/types/src/contacts.ts:374–411`) gains an optional,
  strictly non-PII channel summary — pattern-matching the existing optional projections
  (`dataHealth`, `revealedTypes`):
  `channels?: { emails: { count, primaryStatus }, phones: { count, primaryStatus, lineTypes[] } }`
  — counts of **live child rows** (primary included) plus status/line-type labels. **Never raw
  secondary values pre-reveal** (truepoint-security: masked means masked; a count is a facet,
  a value is PII). `hasEmail`/`hasPhone` keep their meaning (primary-cache presence) so no
  existing consumer changes.
- **`canonicalContactRowSchema`** (`contacts.ts:88–105`) stays single-value (`email`, `phone`)
  — the shipped sync + bulk import paths and the COPY-staging encoder depend on that shape
  (bulk-vs-sync parity, 01 §2.3). The multi-value extension is **additive**: optional
  `additionalEmails?: [{ value, type? }]` / `additionalPhones?: [{ value, type? }]` arrays that
  the mapper populates when the wizard maps multiple source columns (cross-ref doc 08 §mapping;
  interop degrades gracefully to `[{value, type}]`, 03 §3.3 [127][132]). Absent arrays =
  byte-identical behavior to today.
- **`contactFieldEditSchema`** unchanged — channels are edited via 05's channel endpoints, not
  the scalar-edit PATCH.
- **New merge DTOs** (shapes, doc 15 sequences the build): `mergePreviewSchema` (side-by-side
  field matrix + child-count impact summary, masked values pre-reveal), `mergeRequestSchema`
  (`loserContactId`, per-field decisions, Idempotency-Key rides the header), `mergeResultSchema`
  (survivor id, re-point tallies per table, audit event id).

---

## Pre-build reasoning pass (explicit answers)

Per `truepoint-architecture/references/pre-build-thinking.md`; answers cite the owning skills.

- **Source of truth, per field.** Channel values: the child rows (05) own truth; the flat
  columns are a **cache of the primary row**, written only in the same tx as the child-row
  mutation — on any disagreement the child row wins and the cache is rewritten, never the
  reverse (post-cutover; during 05's migration phases the repair direction is phase-dependent —
  flat wins until S-CH4, 05 §3.4). Scalars: the `contacts` columns own truth; `field_provenance` owns *why*. Merge
  state: `merged_into_contact_id` on the loser row. Suggestion state: `duplicate_of_contact_id`.
  No two owners for any datum.
- **Failure modes.** Merge is one `withTenantTx` — a mid-crash rolls back field writes,
  re-points, tombstone, and audit event together (nothing half-merged exists; retry-safe via
  Idempotency-Key). Cache-vs-child drift: prevented by same-tx maintenance; detected by a
  reconcile sweep (a periodic worker comparing primary-row blind index vs cache blind index per
  workspace — count-only metric, repair verb behind the flag; testing hook T4). A failed merge
  surfaces as an RFC 9457 problem; the review UI re-opens with state intact.
- **Duplicate prevention.** The three partial uniques (unchanged) at the DB; child-table value
  uniques (05) for secondaries; merge verb idempotent (re-submitting the same
  survivor/loser pair after commit is a no-op: the loser is tombstoned, the executor refuses
  merged/deleted inputs); `FOR UPDATE` on both rows in deterministic id order prevents the
  concurrent-merge race (§edge cases).
- **Audit.** §4: in-tx `audit_log` rows for scalar edits and `contact.merge`; support can
  reconstruct a merge from audit alone. Actor, timestamp, action on every write.
- **Security** (truepoint-security checklist). IDOR: both merge ids resolved via
  `visibleContactIds` inside the tx (mirrors the shipped bulk-mutation guard,
  `contactRepository.ts:762–767`); RLS remains the tenant wall (DM4) — the customer merge runs
  on `withTenantTx`, never the owner path (the owner path stays grain-A-staff-only with its
  explicit-scope discipline, `platformAdminWrites.ts:333–336`). PII: values stay AES-GCM
  encrypted in child rows and cache alike (05); the masked DTO exposes counts/statuses only
  (§6); audit metadata carries clear scalars only, never channel values. Privilege: the merge
  role gate is server-side (doc 10); the field-decision payload is allowlisted to known fields.
  Rate limit on the merge verb (expensive + destructive).
- **Scalability (10x).** Merge cost is O(loser's children), bounded per-pair and capped
  per-day; every re-point is an indexed FK walk (`idx_activities_ws_contact_occurred`,
  `uniq_list_members_list_contact`, 05's `(workspace_id, contact_id)` child indexes). The cache
  keeps hot list/search reads single-table — the 100M-row read path is unchanged (no join added
  to the masked list projection; counts in §6 come from the same child-index scan that 05
  specifies). No unbounded queries; DTO arrays are capped.
- **Monitoring.** Metrics: merges/day per workspace, re-point tallies, reconcile-sweep drift
  count (alert > 0), merge-verb error rate. The audit event doubles as the analytics event.
- **Rollback.** Dual-gate flag off → verb 403s, engine never constructed; S-C1/S-C2 are
  additive/nullable and reversible (down = drop column/enum value — safe while flag-off wrote
  nothing). Executed merges are *not* rolled back by flag-off (irreversibility is the contract);
  the flag halts new ones.
- **Edge cases.** Self-merge → 400. Loser already merged/tombstoned → 409 with `mergedInto`.
  Survivor tombstoned → 409. Merging *into* a marker chain (loser is canonical for other
  markers) → those markers re-point (§3.4). A→B and B→A submitted concurrently → deterministic
  lock order makes one wait, then fail the merged-input check. `merged_into` chains (A→B, later
  B→C) → readers chase at most one hop per read and the executor collapses chains by re-pointing
  A→C during B's merge — bounded traversal. Both-pinned conflicting scalars → survivor's pin
  wins by default; the user's explicit pick re-pins (planUserEdit). Unknown enum in a decision
  payload → 400 (closed allowlist).
- **Worst case + detection.** A wrong-pair merge is irreversible data damage. Made detectable
  *before* completion by the mandatory side-by-side preview with child-impact counts; bounded by
  the 2-record and daily caps; recoverable-in-extremis via the audit payload + `source_imports`
  provenance runbook (§3.6). The systemic worst case — a bug re-pointing across workspaces — is
  structurally blocked by RLS on the tx + the `visibleContactIds` pre-check, and covered by an
  isolation itest (T2).

---

## Implementation Steps (step IDs — doc 15 sequences; statuses per series legend)

| Step | What | Status |
|---|---|---|
| S-C1 | Additive columns `contacts.merged_into_contact_id` (self-FK) + `merged_at`; partial index on non-null | 🔲 |
| S-C2 | Extend `audit_log` action CHECK + `auditAction` enum with `contact.merge`; scalar-edit audit metadata contract | 🔲 |
| S-C3 | Seed `contact_merge_enabled` per-tenant flag (off) + `CONTACT_MERGE_ENABLED` env kill-switch (dual-gate, 01 §7.3 pattern) | 🔲 |
| S-C4 | Core merge engine (`packages/core`): pure plan (survivor/loser/decisions → write-set via `planFieldWrite`/`planUserEdit`) + tx executor with the §3.4 inventory | 🔲 (depends on 05's S-MV* child tables) |
| S-C5 | API verb `POST /contacts/:id/merge` + preview endpoint; merge DTOs in `@leadwolf/types` (§6) | 🔲 |
| S-C6 | Match-time ladder extension (any-value email resolve + phone-signal marker writes, §2) in `findByDedupKeys` + bulk staging equivalents | 🔲 (after 05) |
| S-C7 | Masked-DTO channel summary + read projection (§6) | 🔲 (after 05) |
| S-C8 | Cache↔child reconcile sweep (count metric + gated repair) | 🔲 |
| S-C9 | Surface-1 wrapper: staff merge via maker-checker calling the same engine (§3.5) | 🔲 (after S-C4) |

Dedup-marker re-point of rows aiming at the loser, and the review-queue read model, ride S-C4
and doc 11 respectively. Employment (G19 ◇) and full field history (G22 ◇) ship **nothing** in
this series beyond §4's audit metadata.

## UI/UX

Owned by doc 11: the duplicate-review queue (G21) and the side-by-side merge review (survivor
preselect, per-field pickers, child-impact counts, explicit irreversibility copy — "This cannot
be undone", mirroring the market's confirm posture, 03 §2.1 [9][70]). Four-state `StateSwitch`,
`@leadwolf/ui`, masked values pre-reveal.

## DB & Backend

§1 (dispositions), §3.4 (inventory), S-C1/S-C2 (DDL). No RLS change (DM4); no new uniques on
`contacts`; child-table DDL is 05's. The merge engine lives in `packages/core` beside
`prospect/fieldProvenance.ts` and is the **only** value-moving merge implementation (DM1);
`apps/api` (Surface 2) and the Surface-1 approval executor both call it.

## API

`POST /api/v1/contacts/:id/merge` + `GET /api/v1/contacts/:id/merge-preview?loser=…` (or POST
preview with the pair) — versioned, Idempotency-Key, RFC 9457 problems (`contact_merged` 409/410
carries a `mergedInto` extension member so a stale detail read of a loser id resolves to the
survivor). Detail reads of a merged id return the 410-style problem, list reads exclude
tombstones as today. Shapes in `@leadwolf/types` (§6).

## Edge Cases

Consolidated in the pre-build pass above (self-merge, chains, concurrent merges, pinned
conflicts, already-merged inputs, cross-workspace ids, unknown enum values).

## Testing

- **T1** Merge inventory completeness itest: build a loser with ≥1 row in *every* Class-A table,
  merge, assert zero rows still referencing the loser (except Class-B ledgers + tombstone) —
  this test is the guard that a future child table added without a merge rule fails loudly.
- **T2** Isolation itest: foreign-workspace loser/survivor ids → refused, nothing written
  (mirrors the grain-A explicit-scope tests).
- **T3** Pin preservation: pinned survivor scalar + conflicting loser value → value unchanged,
  descriptor unchanged; explicit user pick → new pin.
- **T4** Cache↔child invariant: after demotion/promotion sequences the flat columns equal the
  primary child row (property-style over the 05 write verbs).
- **T5** Idempotent replay: same Idempotency-Key / re-submitted pair → no second effect.
- **T6** Reveal/billing: merge never inserts a `contact_reveals` row; claim re-point
  conflict-skips; survivor reveal-trio CHECKs hold.
- **T7** Ladder extension: secondary-*email* match → resolves to the owning contact (upsert,
  05 §6); phone-signal-only match → marker written, no upsert, no block.

## Rollout

Dark until doc 05's tables land and backfill completes (05 owns that sequence); then dual-gate
per tenant (design-partner first), caps low, reconcile-sweep metric green for a full cycle
before widening. Flag-off = byte-identical current behavior. Full phase/gate placement: doc 14;
migration order + rehearsal: doc 15.

## Success Metrics

- Duplicate-marker backlog burns down: ≥X% of open `duplicate_of_contact_id` markers resolved
  (merged or dismissed) within 30 days of enablement (baseline: 0 — nothing resolves today).
- **Zero** Class-A rows referencing a tombstoned loser (T1 sweep in prod as a metric).
- **Zero** pinned-field overwrites by merge (audit-derived).
- **Zero** cache↔child drift steady-state (S-C8 metric).
- Merge p95 within the interactive budget at the 95th-percentile child fan-out; zero
  cross-workspace merge writes (isolation alert).
- No regression on import throughput or masked-list read latency (the cache promise: reads
  unchanged).
