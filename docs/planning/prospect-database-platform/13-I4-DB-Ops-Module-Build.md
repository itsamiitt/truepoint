# 13 — I4: Database-Operations Module (Build Plan + Gates)

**Status:** 📐 Plan only — **no slice below is implemented.** Three things gate the build: the **X3 security
sign-off** (§6), the **§3a split decision**, and — until this document — the absence of the phase's planning
doc, which the program's documentation-first policy requires before implementation. This closes the third;
the first two are human decisions and are stated so they can actually be answered.

**Read §1 first even if you read nothing else.** Both merge executors this phase is nominally about already
exist in some form — the Layer-1 one is fully shipped and live, the Layer-0 one is built and itested but has
no caller. The roadmap row reads as greenfield and is not, and the most likely way to damage this system is
to build a second merge path beside a tested one.

Covers build stage **I4** from [10-Implementation-Roadmap](./10-Implementation-Roadmap.md) — "review queue +
decisions; dedup merge/split executor (non-destructive); record detail (lineage/version/correct); advanced
filters; batch admin" — sitting between [I3](./11-I3-Enrichment-Pipeline-Build.md) (shipped) and
[I5](./12-I5-Probabilistic-ER-Build.md) (shipped, shadow-only).

---

## 1. The distinction the roadmap line hides: which grain is being merged

The roadmap's I4 row reads "dedup merge/split executor (non-destructive)" as if no merge executor exists.
**One does** — at the tenant grain — and reading the row without that context leads straight to rebuilding a
shipped engine.

| | **Layer-1 — tenant contact merge** | **Layer-0 — master-graph dedup** |
|---|---|---|
| Status | **SHIPPED** | **executor BUILT + itested, entirely UNWIRED** |
| Entry | `POST` in `apps/api/src/features/contacts-merge/routes.ts` (preview + run) | **none** — no core function, no route, no UI action |
| Engine | `runContactMerge` (`packages/core/src/prospect/mergeContact.ts:73`) → `contactMergeRepository` | `erRepository.confirmMerge` (`packages/db/src/repositories/erRepository.ts:259`), covered by `packages/db/test/erMerge.itest.ts` |
| Wall | `withTenantTx`, RLS. Never the owner path. | `forge` schema, system-owned, **no tenant key** |
| Subject | two `contacts` rows in ONE workspace | two `master_persons` clusters, **spanning tenants** |
| Who acts | the customer (S-C5), or staff via the maker-checker wrapper (S-C9) | staff only, `data:review` |
| PII exposure | inside one tenant — the caller already sees both records | **cross-tenant name read** — the thing X3 exists to rule on |

Both surfaces call ONE engine at the Layer-1 grain (DM1), and it is not the same problem wearing a different
hat as Layer-0: there is no tenant to scope to, the wall is schema isolation rather than RLS, and the records
being compared belong to different customers.

**The Layer-0 executor is further along than the roadmap row implies, and that changes what I4 is.**
`erRepository.confirmMerge` already re-points `source_records.resolved_person_id`, re-points `match_links`
onto the survivor cluster and flips them to `confirmed`, tombstones the loser (`merged_into_person_id` +
`merged_at`), and appends **two** `provenance_event` rows — one on each side, so reading the loser shows where
it went and reading the survivor shows what it absorbed. `erMerge.itest.ts` covers the two silent failure
modes (half-merge, double-merge) against a real database.

What it has is **no caller**. Nothing in `packages/core`, `apps/api` or `apps/admin` invokes it; the only
callers are tests. So I4 is not "build the executor" — it is **wire the built one**: a decision surface, a
maker-checker binding, a route, and the UI action, with the security answer in §6 as the gate. That is a
materially smaller and safer piece of work than the roadmap row suggests, and mis-reading it as greenfield
would produce a second Layer-0 merge path beside a tested one.

Nothing in this phase should touch `runContactMerge`.

## 2. What already exists (cite, do not rebuild)

| Piece | Where | State |
|---|---|---|
| Clerical review surface | `apps/admin/src/features/data-ops/components/DedupReviewPage.tsx` | **READ-ONLY**, `data:review`-gated server-side, cross-tenant, exposes the matched person name |
| Proposal populator | `packages/core/src/er/*` + `erSweep.ts` (I5) | shipped, **shadow-only**, dark behind `ER_SHADOW_ENABLED`; writes `match_links(review_status='pending', method='splink')` and never merges |
| Maker-checker approvals | `approval_requests` (`packages/db/src/schema/forge.ts:297`), `data_ops` role, `data:*` caps | shipped; `uniq_approval_requests_pending_subject` already prevents two open requests for one subject |
| `match_links` | `packages/db/src/schema/forge.ts:457` | shipped; `idx_match_links_cluster` on `(entity_type, cluster_id)` |
| Tenant merge engine | §1 above | shipped — **out of scope here** |

The queue therefore has a populator and a reader. What it has never had is a **decision**.

## 3. Two conflicts with the roadmap's "merge→split→re-derive" criterion

The roadmap's acceptance criterion for I4 is **"merge→split→re-derive"**. Neither grain can satisfy it today,
for two different reasons — one an oversight, one a deliberate and documented refusal. Surfaced rather than
reinterpreted (CLAUDE.md rule 6); the second in particular is **not mine to overrule**.

### 3a. Layer-0 refuses unmerge on purpose

`erRepository.confirmMerge` tombstones the loser with this next to the write:

> *"Set ONCE, never cleared — there is no unmerge, and pretending otherwise would invite a caller to try."*

That is a considered position, not a gap, and it is defensible: the graph is system-owned, the provenance log
is append-only precisely so history survives a merge, and a reversible tombstone invites callers to treat a
merge as provisional. It also flatly contradicts an acceptance criterion the roadmap states for this phase.

Note that Layer-0 is *technically* invertible — the tombstone is a pointer rather than a delete, the
provenance log is append-only, and the only lossy step is that `confirmMerge` returns `movedSourceRecords` as
a **count** while having the moved ids in hand (`.returning({ id })`) and persisting none of them. So the
question is a product one, not a feasibility one:

> **Decision needed:** does I4 ship a Layer-0 split, or does the roadmap's "merge→split→re-derive" criterion
> get amended to "merge→re-derive, corrections by new evidence"? Building a split against code that says in
> as many words that there is none would be exactly the silent reinterpretation rule 6 forbids.

Slices 6 and the split half of the acceptance criteria below are written **contingent on that answer**.

### 3b. Layer-1 records too little to ever be inverted

The roadmap's acceptance criterion for I4 is **"merge→split→re-derive"**. That round trip is not achievable
against the merge record either grain writes today, and the reason is worth stating precisely because a
comment in the code currently says otherwise.

`contactMergeRepository` records a `contact.merge` audit event whose header claims the merge is
"reconstructable from audit alone". For the **field** half that is true: survivor, loser, the per-field
decision set, the loser's `field_provenance` map and the scalar before/after are all in the metadata. For the
**child** half it is not. `repointChildren` returns `Record<string, number>` — **tallies per child table, not
row identities**. The audit records that 7 `list_members` moved; it does not record which 7. And the
collision rules are worse than lossy: list/tag/reveal/outreach collisions **collapse** (union, never
double-charge) and a phone collision collapses onto the survivor's live row. Those rows are gone with no
record that they ever existed on the loser.

Consequences, in order of how much they cost to fix:

1. **A split implemented on this record would be silently wrong.** It could restore the loser row (the
   tombstone is soft — `deleted_at` + `merged_into_contact_id`) and the scalar fields, then guess at children.
   A merge-split-merge cycle would not be idempotent, and nothing would say so.
2. **Merges already performed are not invertible.** This is not fixable retroactively; the information was
   never written. Any split feature must therefore state a cutover date and refuse to split merges older than
   it, rather than pretend.
3. **Going forward it is cheap.** A merge journal — one row per moved or collapsed child, written inside the
   same transaction — makes both grains invertible. It is a prerequisite for the split half of I4, and it
   should be added to the **Layer-1** engine at the same time even though Layer-1 is out of scope for the
   executor, because that engine is live and accruing un-invertible merges every day it runs without it.

**Recommendation:** the merge journal is slice 1 of this phase, ahead of any decision surface — it is the
only item here whose cost grows every day it is deferred, and it is worth doing even if §3a's answer is "no
split", because "which rows moved in that merge" is a support question long before it is a split feature.

The misleading comment is *already* corrected — in `contactMergeRepository.recordMergeEvent` and at the
`mergeContact.ts` call site, both of which now say what the metadata does and does not recover. That was not
left for slice 1: the claim was live, and anyone building a split against it would have been misled today.

## 4. Slices

Ordered so that everything that can ship without the security sign-off ships first, and the X3-gated work is
isolated at the end rather than threaded through.

| # | Slice | Gated by X3? | What |
|---|---|---|---|
| 1 | **Merge journal** | No | `merge_journal` (or an additive detail table): one row per re-pointed or collapsed child — table, row id, from-contact, to-contact, disposition (`repointed`/`collapsed`), written in the merge transaction. Applied to the LIVE Layer-1 engine. Correct the audit comment. Makes split possible from this date forward. |
| 2 | **Queue decisions — reject** | No | `match_links.review_status: pending → rejected`, with actor + reason. Non-destructive by construction: it changes nothing about the graph, it removes a proposal. Safe to ship because it cannot merge anything. |
| 3 | **Queue decisions — confirm (proposal only)** | No | A confirmed proposal raises a maker-checker *request*, not an effect. Reuses `approval_requests`; `uniq_approval_requests_pending_subject` already gives idempotency. **Careful:** do not write `review_status='confirmed'` here — `confirmMerge` sets that itself as part of executing, so setting it at proposal time would make an unexecuted proposal indistinguishable from a completed merge. Use the approval request as the pending state. |
| 4 | **Record detail — lineage/version/correct** | Partly | Per-record provenance and version history view. The *lineage* read is existing data; the **correct** verb writes and needs the same PII-boundary answer as slice 5. Split it: lineage read first, correction verb with slice 5. |
| 5 | **Wire the Layer-0 executor** | **YES** | The only slice that mutates the master graph — and the engine already exists (`erRepository.confirmMerge`, §1). This slice is the missing caller: a core function that takes an APPROVED request, opens `withErTx`, calls `confirmMerge`, and returns its result; the route; the UI action. Requires slice 3. **Do not write a second merge implementation.** |
| 6 | **Split executor** | **YES** + §3a | Blocked on the §3a decision before it is designed, not just before it is built. If the answer is "no split", this slice is deleted and the roadmap criterion amended in the same commit; if it is "yes", `confirmMerge` must first persist the moved `source_records` ids it already has in hand, and its "there is no unmerge" comment must be retracted deliberately rather than contradicted silently. |
| 7 | Advanced filters, batch admin | No | Queue ergonomics — bounded, read-side, no new exposure. Genuinely last: they are the slice most likely to be built first because it is the easiest, and the one that delivers nothing until decisions exist. |

## 5. Acceptance criteria (as outcome metrics, per CLAUDE.md rule 2)

Every one of these is a test, not a review note.

- **A-03 (fabricated/fraudulent contributions kept out of the graph):** no `match_links` row moves out of
  `pending` without an actor id and a recorded reason. Asserted by an itest that attempts the transition with
  a null actor and expects refusal.
- **A-01 (provenance + lawful basis on every stored field):** a Layer-0 merge writes a provenance event for
  every field the survivor gains. Zero-provenance writes fail the ingestion guard that already exists.
- **Isolation:** the Layer-0 executor runs on the system-owned path and is unreachable from `withTenantTx`.
  Asserted the way `forgeSchemaIsolation.itest.ts` asserts its wall — by `session_user`, not by intent.
- **maker ≠ checker:** the actor who confirms a proposal cannot be the actor who approves its execution.
  One itest, both orders.
- **Invertibility** *(only if §3a is answered "ship a split"; delete this criterion with slice 6 otherwise)*:
  for any merge performed after slice 1, `merge → split` restores the loser's child rows exactly — same ids,
  same count, same table. For a merge performed before slice 1, `split` refuses with a typed error rather
  than doing its best.
- **No second merge path:** `erRepository.confirmMerge` remains the only writer of `master_persons
  .merged_into_person_id`. A grep-style guard, in the spirit of the existing script gates, is cheaper than
  discovering a divergent second implementation later.
- **Non-destructive:** after a Layer-0 merge, `SELECT count(*)` on every affected master table is unchanged.
  A merge that deletes a row fails the suite.

## 6. What X3 must actually decide (§ for the reviewer)

The audit row ([16-Implementation-Audit](../database-management-research/16-Implementation-Audit.md), X3) asks
for an "isolation/PII sign-off" without enumerating the questions. Three, concretely:

1. **The cross-tenant name read.** `DedupReviewPage` already shows a matched person's name to `data:review`
   staff across tenant boundaries — this is shipped and live behind the capability. Is the capability gate
   sufficient, or does the read need per-view audit logging, redaction until a proposal is opened, or a
   two-person rule?
2. **The merge effect.** A Layer-0 merge makes one customer's record and another's resolve to the same golden
   entity. Does that require anything beyond the maker-checker approval — for example a tenant-visible
   provenance event, or an exclusion list for tenants who have contractually opted out of graph participation?
3. **The correction verb** (slice 4). A staff correction to a master field propagates to every tenant reading
   that entity. Is a staff correction lawful basis enough, and what does the affected tenant see?

None of these is answerable from the code, which is exactly why the sequence in §4 puts six slices' worth of
work in front of them.

## 7. Enable gate + rollback

Same shape as I5: the executor slices land dark behind their own env switch (default off, and so recorded in
`deploy/env.production.template` — `bun run lint:prod-switches` fails if it is armed without a reason). Slices
1–3 need no switch: a journal that nobody reads and a queue transition that changes no graph state are inert
by construction.

Rollback for the executor is the split (slice 6), which is why they ship together or not at all. Rollback for
the journal is dropping a write nobody depends on yet.

## 8. Explicitly out of scope

- `runContactMerge` and the Layer-1 tenant merge surface — shipped; only the journal (slice 1) touches it.
- Auto-merge above a probability threshold. I5's disposition includes `auto_match`; **it must stay a proposal
  here.** The roadmap's own guardrail for I5 is "no auto-merge above threshold without a human", and I4 is
  where that guardrail would quietly be dropped if the executor consumed dispositions directly.
- Retuning the matcher (`DEFAULT_FIELD_WEIGHTS` is still a placeholder) — that is I5's clerical loop.
