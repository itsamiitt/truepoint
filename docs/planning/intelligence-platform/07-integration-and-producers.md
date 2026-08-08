# Phase 7 — Application integration: the producers

Reframed by iteration 24's conclusion: the programme's tables are built, granted, indexed and tested but
**empty**. This phase asks the question the brief's lifecycle actually turns on — *what writes the rows* —
and answers it from inspection, not assumption.

The brief requires seven statements before any significant change. They follow in order.

---

## 1. What research found

R3 (signal taxonomy) established six industry-consistent signal families, and RD-4 resolved that only family 5
(intent / content engagement) falls under the deferred non-goal X-04; families 1–4 and 6 — hiring, funding/M&A,
tech-stack change, leadership change, filings — are company facts, in scope, and carry far lighter privacy
weight than person-level intent.

R4 (data decay) put the decay rate at ~2.1%/month with **job change the dominant cause**. That makes the
job-change producer the highest-value single populator on the board: it serves S-09 (2nd), S-13 (5th) and
S-14, and it is the mechanism behind the freshness the whole top of the opportunity table asks for.

The brief's own lifecycle ends *Storage → **Distribution** → Continuous updates*. Distribution is the step
this codebase has never implemented: a fact learned once, in the shared graph, reaching every tenant that
holds the affected record.

---

## 2. What the current system does — verified by reading, not grepping

**The job-change stack is complete and unwired.**

| Piece | File | State |
|---|---|---|
| Detection | `packages/core/src/data-health/jobChange.ts` | Built, pure, unit-tested. Compares *confidences* not timestamps; `CHANGE_MARGIN = 0.1` prevents flapping; "departed" held to the same bar as "moved" |
| Producer | `packages/core/src/data-health/recordJobChange.ts` | Built. Writes `intent_signals` + notifies only watchers; dedups per (user, contact) |
| Successor ranking | `packages/core/src/data-health/successor.ts` | Built, tested, `SUCCESSOR_MIN_SCORE = 0.5` |
| Integration proof | `packages/db/test/jobChangeAlerts.itest.ts` | Exercises the producer end to end |
| **Trigger** | — | **Does not exist.** Repo-wide, the only callers of `recordJobChange` are the itest and the core barrel. No queue, sweep or route calls it. `reverification.ts` does no employment comparison. |

**`intent_signals` has effectively one producer, and it never runs.** Consequences downstream:

- `packages/core/src/scoring/computeScore.ts` reads `recentForContact` for the intent component of the lead
  score — reading an empty table.
- `packages/core/src/prospect/firmographics.ts` rolls `tech_install` → account technologies and
  `funding_round` → funding stage. **Both are consumers; neither type has any producer anywhere in the repo.**

**The `SignalType` enum is largely aspirational.** Of nine values in `packages/types/src/intel.ts`, only
`job_change` has a producer (unwired), and `tech_install` / `funding_round` have consumers with no producer.
The remaining five — `web_visit`, `content_engagement`, `keyword_search`, `linkedin_activity`,
`sales_nav_view` — appear **only in the enum declaration**. Nothing reads or writes them.

**The fan-out shape already exists and is proven.** `apps/workers/src/queues/channelReconcileSweep.ts` (and
its sibling `channelBackfillSweep`) implement exactly the Layer-0-change → per-tenant-write pattern this phase
needs: leader-locked so exactly one worker runs it; an owner-connection census returning **non-PII ids only**,
capped per tick; then per workspace a `withTenantTx` keyset batch loop with RLS enforcing — explicitly
"never the owner conn for writes"; then counters and a drift gauge. Env-gated dark by default.

---

## 3. What is wrong

Three things, in descending severity:

1. **The highest-value populator is one function call from working and nobody makes the call.** Detection,
   scoring, persistence, alerting, dedup and successor ranking are all built and tested. S-13 measures *time
   between a contact changing jobs and the seller learning* — currently unbounded, because nothing looks.
2. **Two consumers read a table no producer fills.** The lead score's intent component and the firmographic
   rollup silently contribute zero. That is not a crash; it is a feature that appears to work and is inert —
   worse, because nothing signals the absence.
3. **The enum advertises capability that strategy forbids.** `web_visit`, `content_engagement` and
   `keyword_search` *are* X-04 intent data. `linkedin_activity` and `sales_nav_view` could only be populated
   by means CLAUDE.md hard-constraint 4 prohibits. They are inert today, so this is a latent trap, not a live
   violation — but the next engineer reading the enum will reasonably conclude these are planned.

---

## 4. Proposed solution

**Slice 7.1 — the job-change fan-out sweep.** One new sweep, built on the `channelReconcileSweep` shape,
joining the two halves that already exist:

```
tick (leader-locked, env-gated dark)
  1. withErTx  — census: master_persons whose current master_employment stint changed
                 since the last watermark. Layer-0 read, ids only.
  2. owner conn — for each changed master_person, the workspaces holding a contact
                 linked to it. NON-PII ids only, capped per tick.
  3. per workspace, withTenantTx (RLS enforcing):
       prior  = the contact's believed employment
       observed = the new Layer-0 stint
       verdict = detectJobChange(prior, observed)     ← existing, pure, tested
       recordJobChange(tx, {...verdict})              ← existing, writes signal + alerts
```

Nothing new is invented. The sweep is the wire; both ends are shipped code.

**Why the census must run on the owner connection and return only ids:** enumerating *which tenants hold a
given person* is a cross-tenant read no tenant role may perform. `leadwolf_app` is correctly unable to do it.
That is precisely why `channelReconcileSweep` splits census (owner, ids) from writes (per-tenant, RLS
enforcing) — and it is a C-02 boundary, not a convenience: the census result set is itself sensitive, so it
stays inside the worker and never reaches a response.

**Slice 7.2 — narrow the `SignalType` enum, or comment it.** Recommended: leave the values (removing them is
a breaking change to a shipped zod schema and to any persisted row) and add a comment marking the five
un-populatable types as X-04-deferred / constraint-blocked, naming the rule. Cheap, honest, and prevents the
next engineer from building a producer for `sales_nav_view`.

**Not proposed:** producers for `tech_install` / `funding_round`. Those need the licensed feed that C4/RD-7
gates, and inventing a source to fill them would be exactly the "collection beyond user-initiated actions"
the hard constraints forbid.

---

## 5. Why this is better than the alternatives

- **Versus building signal producers first:** the job-change path already has a decision function whose
  judgement has been reasoned about and tested (confidence comparison, anti-flap margin, departure held to
  the same bar). A new producer would need all of that re-derived. This buys the highest-scoring outcomes
  with the least new code.
- **Versus wiring detection into the reverification queue:** reverification is per-contact and tenant-scoped;
  job change is a fact about a *person* that must reach every tenant holding them. Putting it in
  reverification would re-derive the same change once per tenant per contact, wasting work and — worse —
  letting two tenants reach different verdicts about the same person from the same evidence.
- **Versus a new bespoke sweep shape:** `channelReconcileSweep` already solved leader-locking, capping,
  keyset resumption, the env gate, the fail-closed dynamic abort, and the census/write connection split. A
  second shape would be a second set of bugs.

---

## 6. Risks and trade-offs

| Risk | Mitigation |
|---|---|
| **Alert storms.** The first run sees every historical employment change at once and could notify every watcher of everything. | Ship dark behind an env gate; seed the watermark to "now" on first run so the first tick detects only *forward* changes. The dedup in `recordJobChange` bounds per-contact repeats but not the initial burst — the watermark is the real defence. |
| **A wrong "departed" verdict removes a live contact from lists and sequences.** `jobChange.ts` names this exact failure. | The margin and the confidence comparison already guard it. Do not add a lower-confidence path; ship display-only alerting before any automated list mutation. |
| **Census cost at scale.** Enumerating workspaces per changed person is a cross-tenant scan. | Cap per tick (the 25-workspace precedent), keyset-resume, and drive off a watermark so steady-state work is proportional to *changes*, not to corpus size. |
| **The Layer-0 side may be thin.** `master_employment` is populated by the ER/master-backfill path; if few contacts resolve to a master person, the sweep finds little. | Measurable, not fatal: instrument the census count. A low number is information about ER coverage, which is itself worth knowing. |
| **C9 is unresolved.** `detectJobChange` composes `computeFieldConfidence` from `@leadwolf/types`. | This *reinforces* the C9 recommendation — the shipped model is load-bearing for a tested decision path. Do not wire the duplicate. |

---

## 7. How existing data and functionality are protected

- **No schema change. No migration.** This slice adds a worker file and registration only.
- **No existing behaviour changes when the gate is off** — the sweep is not registered, exactly as
  `channelReconcileSweep` is dark without its env pair.
- **All writes go through `withTenantTx` with RLS enforcing**, through the existing `recordJobChange`, which
  is already covered by `jobChangeAlerts.itest.ts`. The owner connection is used only for a read-only,
  ids-only census — never for a write.
- **No new personal data is collected, stored, or displayed.** The sweep derives a signal from employment
  facts already in the graph. Alert copy is already PII-free by construction (`recordJobChange` documents
  "NEVER an email or phone — a notification is not a reveal").
- **Compliance impact (rule 3):** no new category of personal data; no new collection path; no change to
  lawful basis. Existing DSAR erasure is unaffected — `intent_signals` is tenant-scoped and already inside
  the tenant erasure path. *This still needs the 09-compliance checklist run at implementation time, not
  assumed here.*

---

## Open, carried forward

- **C9** (two confidence implementations) — now load-bearing for this slice; recommendation unchanged.
- **C4 / RD-7** — gates the technology-adoption populator entirely; still unsigned.
- **`master_signals` is the second empty signal store.** Its relationship to `intent_signals` needs stating
  explicitly before either grows a producer: Layer 0 = the shared fact about a person/company; Layer 1 =
  the tenant's copy that scoring and alerts read. The fan-out designed above is exactly the bridge, and if
  slice 7.1 ships, the natural follow-on is for it to write the Layer-0 `master_signals` row **once** and
  fan Layer-1 `intent_signals` rows from it — rather than the current design's tenant-only write. Deliberately
  **not** in slice 7.1: it doubles the surface, and the Layer-1 half delivers the outcome on its own.
