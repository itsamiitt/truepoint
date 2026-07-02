# Re-Audit & Residual Risks (Second-Pass Adversarial Review)

> **Objective 5 deliverable.** This is a *second-pass, adversarial* review of the **proposed target
> architecture and migration plan** — [07-target-architecture.md](07-target-architecture.md),
> [08-migration-strategy.md](08-migration-strategy.md),
> [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md),
> [10-observability-alerting.md](10-observability-alerting.md),
> [11-capacity-finops.md](11-capacity-finops.md), and [12-security-review.md](12-security-review.md),
> against the gap analysis in [06-gap-analysis.md](06-gap-analysis.md). Its job is **not** to restate
> those docs but to *attack* them: where does the proposed target still leak, over-claim, contradict a
> sibling, or introduce a *new* failure mode the first pass did not price in?
>
> **Register discipline (unchanged from the corpus).** **[As-built]** = code today, with a `path:line`
> citation. **[Intended]** = a sanctioned ADR/`§18`/`§19` design. **[Rec]** = a proposal. This doc adds a
> fourth tag: **[Target-flaw]** = a weakness *in the proposed target/plan itself*, which is what this
> review hunts.
>
> **Framing preserved.** The corpus's central lens — *most current darkness is safe-by-default, not a
> defect* — is correct and is **not** relitigated here. This review instead stress-tests whether the
> *proposed cure* is sound. Several findings show the cure introduces its own risks (a relay bottleneck,
> a racy budget breaker under scale, a cross-region split-brain) that must be designed out **before**,
> not after, the corresponding phase ships.

---

## How findings are ranked

By **blast radius × likelihood at the phase where the flaw first bites**, using the corpus severity
convention ([06 §1](06-gap-analysis.md)): **P0** = correctness / spend-safety / data-loss risk that the
*proposed target* still carries (or newly introduces); **P1** = will break or badly degrade at target
scale as designed; **P2** = consistency / doc-integrity / lower-blast issues. Each finding names the
**affected doc(s)**, the **defect in the proposal**, why it matters, and a **recommended revision**.

| # | Finding (short) | Priority | Primary affected doc |
|---|---|---|---|
| F1 | Outbox relay is a single-leader bottleneck that contradicts its own `SKIP LOCKED` design; relay lag = a *new* stuck state | **P0** | 07 §5, 09 §6.2 |
| F2 | "Reuse the `projection_outbox` daily-sweep shape" is a category error for a latency-critical money relay | **P0** | 08 §Phase 2 |
| F3 | Daily budget breaker is a racy check-then-act; autoscaling arms bulk-enrich (08 Phase 4) with no gate on the atomic credit lease → cost blow-up | **P0** | 11 §6.2, 08 §Phase 4 |
| F4 | DR "zero duplicate spend" over-claims: the idempotency ledger is in Aurora (RPO 5 min) → failover re-runs up to 5 min of paid work | **P0** | 07 §9, 09 §10, 08 exit criteria |
| F5 | Multi-region has **no** cross-region mutual exclusion: the leader lock is per-cluster + fenceless → split-brain double-runs retention/billing sweeps | **P0** | 07 §9, 12 |
| F6 | Leader-lock TTL is fenceless; the target adds *new* singleton work (the relay) with no `SKIP LOCKED` backstop → double-publish under GC pause at N replicas | **P1** | 07 §5, 09 §9 |
| F7 | Per-tenant concurrency cap conflates a refill token-bucket with a concurrency lease → slot leaks on crash → tenant self-starvation | **P1** | 07 §6.2, 11 §5.2 |
| F8 | Per-tenant fair-queueing conflicts with the hash-tag/one-slot cluster reality at tenant scale; BullMQ "groups" fairness is an unstated **BullMQ Pro** commercial dependency | **P1** | 07 §4.1, 11 §5.2 |
| F9 | Three separate Redis clusters fragment the single outbox relay; a boolean `sent_at` cannot model partial multi-cluster publication; cross-tier flows become impossible | **P1** | 07 §3, §5 |
| F10 | DLQ redrive poison-loop: idempotency stops double-*effect*, not re-*failure*; no deterministic-skip, no max-redrive cap, no redrive rate-limit | **P1** | 07 §7.1, 09 §7.2, 10 §9 |
| F11 | Autoscaler flapping + cold-start + age-based runaway on a single stuck job; no stabilization window; money-tier scale-to-zero fights its own latency SLO | **P1** | 07 §6.1, 11 §4.2/§8 |
| F12 | Full tracing at billions of jobs has no async sampling policy; per-row spans = billions of spans/job, cost-prohibitive | **P1** | 10 §5 |
| F13 | Phase-4 autoscale gate is incomplete: enqueue-after-commit survives on the fan-out producers under scale-out (only *consumer* idempotency + *one* producer are gated) | **P1** | 08 §Phase 2/4, 09 §6.1 |
| F14 | `/ready` Redis `PING` must probe the *blocking consumer* connection post role-split; readiness flap + aggressive restart = restart storm that loses in-flight work pre-outbox | **P1** | 07 §4, 10 §6, 08 §Phase 1 |
| F15 | Documentation consistency: Temporal is named the target orchestration home but absent from the plan and contradicts "no rewrite"; the `15-*` cross-refs are self-flagged unverified | **P2** | 07 §4.2, 08 §8 |

---

## P0 — the proposed target still carries (or newly introduces) a correctness / spend risk

### F1 — The outbox relay is a single-leader bottleneck that contradicts its own `SKIP LOCKED` design; relay lag is a *new* stuck state

**[Target-flaw].** The keystone recommendation — the transactional outbox — is specified two different,
**mutually incompatible** ways across the corpus:

- [07 §5](07-target-architecture.md) proposes a polling relay doing `SELECT … FROM outbox WHERE sent_at
  IS NULL … FOR UPDATE SKIP LOCKED` (`07-target-architecture.md:331-332`). `SKIP LOCKED` exists
  *specifically* to let **many** drainers run concurrently without contending.
- But the **same bullet** then says to reuse the leader-lock primitive "so **only one relay instance
  drains at a time**" (`07-target-architecture.md:333-334`), and [09 §6.2](09-reliability-fault-tolerance.md)
  hard-wires it: "a relay (a **new leader-locked sweep**, reusing `withLeaderLock`)"
  (`09-reliability-fault-tolerance.md:293-296`).

You cannot have both. Pinning the relay to a single leader **throws away** the `SKIP LOCKED`
concurrency and makes the relay a **fleet-wide serialization point** for *every* domain event — at the
"billions of jobs" target this is a throughput ceiling on the exact path the outbox was added to make
reliable. It is also **new DB write amplification** the docs never quantify: every state change now
costs an extra `INSERT` (outbox row), every publish an `UPDATE` (mark sent), plus the relay's polling
`SELECT` load — all on the same Aurora primary [11](11-capacity-finops.md) is simultaneously trying to
keep under its connection/write ceiling.

**Why it matters.** [08 §10](08-migration-strategy.md) already lists "**Outbox relay lag creates a new
stuck state**" as a Med/Med migration risk (`08-migration-strategy.md:533`) but does **not** resolve the
single-leader contradiction that *causes* the lag. A single relay that falls behind converts the
"lost-enqueue" defect it was meant to fix into a "delayed-enqueue" defect — the confirm→drive path now
waits on relay cadence, threatening the enrichment freshness SLO ([ADR-0024 p95 < 10 min]).

**Recommended revision (07 §5, 09 §6.2).** Pick **one** relay concurrency model and state it once:
1. **Preferred:** drop the leader lock for the relay and run **N leaderless drainers** using `FOR UPDATE
   SKIP LOCKED` over a **partitioned** outbox (hash by `domain` or `tenant_id` into P partitions); this
   scales horizontally and is what `SKIP LOCKED` is for. Idempotent consumers ([09 §5](09-reliability-fault-tolerance.md))
   already make a double-publish harmless, so the leader lock buys nothing here.
2. For the highest-volume domains, prefer the **CDC relay** ([07 §5 option 2](07-target-architecture.md:335-337))
   to remove polling load entirely.
3. Add an explicit **relay-lag SLO + alert** (outbox `age(now − oldest unsent)`) to
   [10 §9](10-observability-alerting.md), and **quantify** the outbox write amplification against the
   Aurora budget in [11](11-capacity-finops.md).

---

### F2 — "Reuse the `projection_outbox` daily-sweep shape" is a category error for a latency-critical money relay

**[Target-flaw].** [08 Phase 2](08-migration-strategy.md) advises reusing an existing drainer: "a
projection-outbox drainer pattern **already exists** (`projection_sweep` drains `projection_outbox`) …
reuse its shape rather than inventing one" (`08-migration-strategy.md:301-305`). But per the ground-truth
brief (queue #10), `projection_sweep` is a **daily, leader-locked, cap-2000** batch sweep, inert unless
`INGESTION_EVIDENCE_ENABLED` is on. That cadence is correct for a *projection backfill* and **catastrophic**
for a *transactional relay*: the confirm→drive enqueue that gates spend would inherit a **≤ 24 h**
publication latency and a 2000-row cap.

**Why it matters.** [07 §5](07-target-architecture.md) correctly wants the relay to be continuous or
CDC-driven, but [08](08-migration-strategy.md) tells the implementer to clone a **daily batch** template.
An engineer following 08 literally would ship a relay that makes the money path *slower and more capped*
than the enqueue-after-commit it replaces — a regression dressed as a fix.

**Recommended revision (08 Phase 2).** Correct the reuse claim: **only the `withLeaderLock` primitive
and the `FOR UPDATE SKIP LOCKED` drain query are reusable** from `projection_sweep` — **not** its daily
cadence or its 2000-row cap. The relay is a **continuous** (sub-second poll) or **CDC** process. State
the target relay latency budget explicitly (e.g. p95 < 2 s enqueue-after-commit) and reconcile it with
F1's concurrency model.

---

### F3 — The daily budget breaker is a racy check-then-act; the plan arms bulk-enrich under autoscale with no gate on the atomic credit lease → cost blow-up

**[As-built + Target-flaw].** The FinOps story in [11](11-capacity-finops.md) rightly calls the per-run
cap "atomic, cross-chunk-aware" (`addRunSpendReturningTotal`, `11-capacity-finops.md:350-353`). But the
**daily budget breaker** — the coarse backstop that protects the *whole workspace* — is **not** atomic.
Verified in code:

```
enrichContact.ts:126   const spent = await providerCallRepository.spendSince(tx, workspaceId, startOfUtcDay());
enrichContact.ts:131   if (spent >= env.ENRICH_DAILY_BUDGET_MICROS) throw ProviderBudgetExceededError;
enrichContact.ts:139   const outcome = await runWaterfall(...);   // spends AFTER the check
```

This is a **read-check-act race** (`packages/core/src/enrichment/enrichContact.ts:125-139`). At
**concurrency 1** (today) it is safe. The moment [08 Phase 4](08-migration-strategy.md) raises
concurrency and scales replicas, **N in-flight workers can all read `spent < budget` simultaneously and
all proceed** — overshooting the daily budget by up to **N paid calls**. [11 §6.2](11-capacity-finops.md)
notes per-*run* overshoot is "≤ C contacts" but never flags that the **daily/workspace** breaker has the
*same* race with **no** atomic accrual behind it.

**Why it matters — the sequencing hole.** [11 §10](11-capacity-finops.md) makes the **per-batch credit
lease** (ADR-0029/0036) — the real fix that makes overshoot *exactly zero* — a **P1** item
(`11-capacity-finops.md:499`), while the resume path and budget calibration are P0. But **[08 Phase 4
(autoscaling)](08-migration-strategy.md) declares no dependency on the lease**, and its only spend-safety
invariant is "spend gates unchanged" (`08-migration-strategy.md:551`). So the plan permits arming
bulk-enrichment **under autoscale** with only the *racy* daily breaker as the workspace-level backstop.
Under a low-hit-rate flood ([11 §7 "Scale"/"Target" rows], `11-capacity-finops.md:417-418`) that race is
the difference between a bounded and an unbounded provider bill.

**Recommended revision (11 §6.2, 08 Phase 4).**
- Make the daily breaker **atomic** (accrue-and-check in one statement, mirroring the per-run cap's
  `addRunSpendReturningTotal`) as a **P0**, not a byproduct of the lease.
- Add a **hard gate** to [08 Phase 4](08-migration-strategy.md): *do not raise concurrency / scale
  replicas on the spend path until the per-batch credit lease (ADR-0029) is live* — because overshoot is
  `O(C)` and C is what Phase 4 increases. Put the lease on the Phase-4 critical path, not P1.

---

### F4 — DR "zero duplicate spend" over-claims: the idempotency ledger lives in Aurora (RPO 5 min), so failover re-runs up to 5 minutes of *paid* work

**[Target-flaw / over-claim].** The corpus is careful about *exactly-once vs effectively-once* in the
steady state ([09 §5.2](09-reliability-fault-tolerance.md) is exemplary). But the **DR** sections quietly
over-claim. [07 §9](07-target-architecture.md) states "idempotent consumers make re-drive after failover
**safe** — replaying outbox events into the promoted region **cannot double-charge**"
(`07-target-architecture.md:544`), and [08](08-migration-strategy.md) lists "**zero duplicate spend**" as
a Phase-5 **exit criterion** (`08-migration-strategy.md:461`, `:552`).

That is only true if the **idempotency ledger replicates synchronously (RPO 0)**. It does not. The
bulk-enrich idempotency guard reads chunk status and accrues spend **in Aurora**
(`bulkProcessEnrichChunk.ts:106-108,187`, per [09 §5.1](09-reliability-fault-tolerance.md)), and DR is
explicitly **RPO 5 min** ([07 §1](07-target-architecture.md:65), `19 §6`). Therefore a paid chunk that
*completed in region A within the 5 minutes before the region was lost, but whose ledger row had not yet
replicated,* will be **re-run in region B** on failover → **duplicate spend** for that chunk's paid
contacts. Bounded by the RPO window, but **not zero**. Worse, the per-run cap that would normally catch
it *also* reads the (stale, 5-min-behind) spend total, so the cap itself under-counts on a freshly
promoted region.

**Why it matters.** "Zero duplicate spend" as a signed-off exit criterion is a claim an enterprise
auditor will test and find false; the honest bound must be stated so operators size the daily breaker as
the true backstop.

**Recommended revision (07 §9, 09 §10, 08 exit criteria).** Restate the guarantee as **"duplicate spend
is bounded by the RPO window (≤ 5 min of in-flight paid work) and backstopped by the daily budget breaker
(F3) and the confirmed per-run ceiling."** Either (a) accept that bound explicitly, or (b) if truly zero
is required, replicate the *idempotency/spend ledger* synchronously (RPO 0) even though the bulk *data*
tolerates RPO 5 min — a targeted, affordable exception. Change 08's exit criterion from "zero duplicate
spend" to "duplicate spend ≤ RPO window, reconciled and within daily budget."

---

### F5 — Multi-region has **no** cross-region mutual exclusion: the leader lock is per-cluster and fenceless → split-brain double-runs the retention/billing sweeps

**[Target-flaw].** [07 §9](07-target-architecture.md) and [09 §9-10](09-reliability-fault-tolerance.md)
lean on "sweeps are leader-gated" as the safety story for scale-out and DR. But the leader lock is a
`SET key token PX ttl NX` on **one Redis instance** (`apps/workers/src/leaderLock.ts:24`), and the target
gives **each region its own Redis** ([07 §9 diagram](07-target-architecture.md:522,528): `A_RD`, `B_RD`).
A lock in region A's Redis is **invisible** to region B. Therefore, during a **network partition** (the
scenario DR exists for — as opposed to a clean, coordinated failover), if both regions are live, **both
regions' maintenance pools can win their *local* leader lock and run the same sweep simultaneously** —
classic split-brain. The standby's workers are "scaled to 0" in the happy path
(`07-target-architecture.md:526`), but a partition is precisely when the standby gets promoted while the
old primary may **still be running**, and there is **no fencing token** to stop the stale primary.

This is not academic for the *destructive* sweeps: once armed, `data_retention_sweep` issues owner-connection
`DELETE`s (`12-security-review.md:277`, `runRetentionSweep.ts:78-107`) and the billing sweeps mutate
ledgers — two of them running cross-region against a split-brained database is a data-integrity event,
and **retention has no idempotency contract** the way bulk-enrich chunks do.

**Why it matters.** The DR design's core promise (safe promotion) rests on a lock that provides **zero**
cross-region guarantee. The first pass never states that the leader lock is single-Redis-scoped.

**Recommended revision (07 §9, 12).** Add an explicit **cross-region fencing** design: (a) run
singleton/destructive sweeps only in the **active** region, gated by a **region-role token** (from the DB
promotion state, which *is* the SoR), not a Redis lock; (b) require a **fencing token** (monotonic, DB-issued)
checked at the point of the destructive write so a stale primary's late write is rejected; (c) state
plainly that `withLeaderLock` is **intra-cluster only** and is not a partition-safe or cross-region
primitive. Cross-reference the security blocker: this belongs alongside [12](12-security-review.md)'s
"do not scale beyond one replica without B1/B3" gate (`12-security-review.md:470`).

---

## P1 — will break or badly degrade at target scale as designed

### F6 — The leader lock is fenceless; the target adds *new* singleton work (the relay) that has **no** `SKIP LOCKED` backstop

**[As-built + Target-flaw].** The leader lock's own header comment is disarmingly honest: it is
"**belt-and-suspenders** on top of the claim's `FOR UPDATE SKIP LOCKED` (which already makes a double-tick
safe) + the BullMQ repeatable-job dedupe" (`apps/workers/src/leaderLock.ts:1-5`). In other words, **today
the lock is not the real safety mechanism** — `SKIP LOCKED` and repeatable-dedupe are. That is why a
fenceless `SET…PX…NX` TTL mutex (unsafe under a stop-the-world pause per Kleppmann: a holder that pauses
past its TTL and a new holder can both run) is *tolerable* today.

The target breaks that assumption. [07 §5](07-target-architecture.md) / [09 §6.2](09-reliability-fault-tolerance.md)
make the **relay** a leader-locked singleton, and F1's *own* recommendation (if leader-locked) has the
relay publishing to Redis with **no `SKIP LOCKED` backstop on the publish side** — a GC/CPU pause on the
relay leader past its TTL lets a second relay acquire the lock and **double-publish** the same outbox
rows. Idempotent consumers absorb the *effect*, but this doubles queue load precisely during the stall
that caused it. At **N replicas** ([08 Phase 4](08-migration-strategy.md)), every leader-gated sweep
inherits the same fenceless-pause exposure.

**Recommended revision (07 §5, 09 §9, 08 Phase 4).** State the fencing limitation explicitly. For the
relay, prefer F1's **leaderless partitioned `SKIP LOCKED`** model (which *is* pause-safe by construction).
For any remaining singleton work, size `lockDuration`/TTL **> max expected GC pause + headroom**, and for
destructive singletons add a DB-side fencing token (F5). Do not present `withLeaderLock` as a correctness
guarantee for scale-out; it is a convenience with a known pause hazard.

### F7 — The per-tenant concurrency cap conflates a refill token-bucket with a concurrency lease → slots leak on crash → tenant self-starvation

**[Target-flaw].** [07 §6.2](07-target-architecture.md:407) and [11 §5.2](11-capacity-finops.md) propose
a per-tenant concurrency cap and say to **"reuse the token-bucket shape"** of the mailbox throttle. But
the mailbox throttle is a **refill-then-consume rate limiter** — verified atomic Lua that refills over
elapsed time and never needs an explicit release (`apps/workers/src/mailboxThrottle.ts:20-33`). A
**concurrency cap** is a different primitive: it is an **acquire-on-start / release-on-finish lease**.
The two are not interchangeable:

- If you implement the cap with **token-bucket (refill) semantics**, it becomes a *rate* limit, not a
  *concurrency* limit — after the refill interval it will admit more than the intended concurrent ceiling.
- If you implement it as a **lease counter** (the correct choice), it **leaks on crash**: a worker that
  holds a tenant's slot and dies (SIGKILL mid-job — the very drain-timeout defect in
  [09 §4.3](09-reliability-fault-tolerance.md); or a hung vendor call, [09 §8](09-reliability-fault-tolerance.md))
  never releases → the tenant's effective cap **shrinks permanently** → the tenant eventually **starves
  itself**. Fairness code that starves the tenant it protects is worse than none.

**Recommended revision (07 §6.2, 11 §5.2).** Specify the cap as a **lease with a TTL/heartbeat reclaim**
(mirror the leader lock's TTL-bounded holder, `leaderLock.ts:24`), so a crashed holder's slot auto-frees;
do **not** describe it as "the token-bucket shape." Add **in-flight-rows** accounting alongside job-count
([11 §5.2 point 3](11-capacity-finops.md:302-304)) with the same reclaim discipline. Add aging to the
fair-share dispatch so a tenant submitting many small jobs cannot repeatedly beat a starved tenant's one
large job.

### F8 — Per-tenant fair-queueing conflicts with the hash-tag/one-slot cluster reality; BullMQ "groups" fairness is an unstated **BullMQ Pro** commercial dependency

**[Target-flaw].** [07 §4.1](07-target-architecture.md) correctly establishes that on Redis Cluster every
key of a queue must share a hash tag and collapse to **one slot**, so "a single queue does **not** shard
across the cluster" (`07-target-architecture.md:251`). But [11 §5.2](11-capacity-finops.md) then offers,
as fairness option (a), "**shard by tenant into per-tenant queues** with a round-robin worker"
(`11-capacity-finops.md:299-300`). At millions of tenants that is **millions of single-slot BullMQ
queues** — an explosion of Redis keys, per-queue schedulers/workers, and slot hotspots the cluster
**cannot rebalance** (you cannot split one slot's load). It directly contradicts 07 §4.1's own guidance
to prefer "many single-slot queues" *sized to domains, not tenants*.

Option (b) — "BullMQ **group-based** rate limiting / priorities keyed on `tenant_id`"
(`11-capacity-finops.md:301`) — is the right shape, **but** BullMQ **groups are a BullMQ Pro (paid,
closed-source) feature**, not part of the OSS `bullmq ^5.0.0` the repo uses (per the brief). Neither 07
nor 11 states this **procurement / cost / license dependency**, which is a real implementation risk and a
single-vendor lock-in on the fairness mechanism the whole multi-tenant scale story depends on.

**Recommended revision (07 §4.1, 11 §5.2).** Reject per-tenant-queue sharding at tenant scale explicitly
(cite the one-slot reality). Adopt tenant fairness via an **application-level weighted dispatcher** over
per-domain queues (a Redis-backed per-tenant lease from F7 + a fair-share picker), which stays on OSS
BullMQ; **or** budget for **BullMQ Pro** and name it as a dependency with cost. State the choice; do not
leave two incompatible options unresolved.

### F9 — Three separate Redis clusters fragment the single outbox relay; a boolean `sent_at` cannot model partial multi-cluster publication

**[Target-flaw].** [07 §3](07-target-architecture.md) splits the fleet across **three Redis clusters**
(T0 money / T1 bulk / T2 maintenance) and [07 §5](07-target-architecture.md) has **one** relay publishing
to "`RMoney & RBulk & RMaint`" (`07-target-architecture.md:132`). But the outbox schema shows a single
boolean-ish `sent_at` (`07-target-architecture.md:314, 331`). If a row's target queue lives in a cluster
that is momentarily down, the relay faces **partial publication** with **no way to record "sent to T0 but
not T1"** — it must either block the whole relay on one degraded cluster or risk marking a row sent that
never reached its queue. Additionally, cross-tier BullMQ **Flows/parent-child** (e.g. an import in T1 that
should atomically spawn dedup/firmographics) are **impossible across clusters** — a stronger version of
the same-slot constraint 07 §4.1 already names (`07-target-architecture.md:254`).

**Recommended revision (07 §3, §5).** Give the outbox a **`target` (cluster/queue) column and per-target
delivery state** (or one outbox partition per target) so partial multi-cluster publication is
representable and independently retryable. Forbid cross-tier Flows in the design and route any
parent-child dependency within a single tier. Re-examine whether **three clusters** earns its keep versus
one HA cluster with per-tier key prefixes + logical DBs, given the relay complexity it forces.

### F10 — DLQ redrive is a poison-loop waiting to happen: idempotency stops double-*effect*, not re-*failure*

**[Target-flaw].** [07 §7.1](07-target-architecture.md) and [09 §7.2](09-reliability-fault-tolerance.md)
make redrive "first-class" and justify its safety as "**safe because consumers are idempotent**"
(`07-target-architecture.md:459-460`). That conflates two different guarantees. Idempotency prevents a
redriven job from applying its side effect **twice**; it does **nothing** to stop a **deterministic**
poison record (bad schema, constraint violation) from **failing again** the instant it is redriven —
straight back into the DLQ. An operator (or an automated redrive) that retries the DLQ blindly creates a
**redrive loop**, and [10 §9](10-observability-alerting.md)'s only guard is a "DLQ growth" alert
(`10-observability-alerting.md:394`) that would fire on the *symptom* without preventing the *cause*. A
**mass** redrive of a large DLQ also re-creates the exact **thundering-herd** against a recovering
dependency that [09 §2.2](09-reliability-fault-tolerance.md) warns about for retries.

**Recommended revision (07 §7.1, 09 §7.2, 10 §9).** Redrive admission must: (1) **skip records the
transient/deterministic classifier ([09 §2.3](09-reliability-fault-tolerance.md)) marks deterministic** —
route them to a terminal *quarantine/parking* queue, not the source queue; (2) enforce a **max-redrive
count per record** (the `redriven` marker in `09-reliability-fault-tolerance.md:333` must carry a
counter, not just a flag); (3) **rate-limit + jitter the redrive itself** so a bulk replay does not
hammer the dependency. State that idempotency guards *effect*, not *re-failure*.

### F11 — Autoscaler flapping, cold-start on bursty confirm-gated jobs, and age-based runaway on a *single stuck* job

**[Target-flaw].** [07 §6.1](07-target-architecture.md) / [11 §4.2](11-capacity-finops.md) autoscale on
**oldest-job age** (primary) + depth, and [11 §8](11-capacity-finops.md:463-465) recommends
**scale-to-zero when idle** for bulk. Three interacting hazards are unpriced:

1. **Cold-start vs a latency SLO.** Bulk-enrichment is **confirm-gated and bursty** — a full job
   materializes the instant a human clicks confirm. Scale-from-zero pays Fargate task-pull + Bun boot +
   the whole-app env validation that *crashes on any missing key* (`packages/config/src/env.ts:328-335`)
   on the **critical path** of a freshness SLO. The **money tier (T0)** should **not** scale to zero.
2. **Flapping.** A single drive fanning into 50 chunks ([11 §3.3](11-capacity-finops.md)) spikes depth,
   the autoscaler scales out, the burst drains in minutes, it scales back in — oscillation. The docs
   mention min/max bounds (`08-migration-strategy.md:416`) and 60 % headroom but specify **no
   stabilization window / cooldown**.
3. **Age-based runaway on a stuck job.** `oldest-job age` climbs **unboundedly** for a *hung/poison* job
   ([09 §8](09-reliability-fault-tolerance.md)) that adding replicas **cannot** help — the autoscaler
   burns money scaling out against a job that is stuck, not backlogged. [11 §4.2](11-capacity-finops.md:258)
   already says DLQ growth should "**page, don't autoscale**"; the identical logic is missing for
   oldest-job-age.

**Recommended revision (07 §6.1, 11 §4.2/§8).** Set a **min replica ≥ 1 (warm) for T0**; scale-to-zero
only T1/T2. Add explicit **scale-out/scale-in stabilization windows** and a **max step size** to prevent
flapping. Make age-based scaling **exclude the single-stuck-job case**: if `depth` is flat while `age`
climbs, that is a **stall → page + DLQ/redrive**, not a scale event (guard identical to the DLQ-growth
rule).

### F12 — Full distributed tracing at billions of jobs has no async sampling policy; per-row spans are cost-prohibitive

**[Target-flaw].** [10 §5](10-observability-alerting.md) mandates injecting `traceparent` into **every**
job and continuing the trace in the consumer, with the consumer emitting "child spans: chunk fan-out,
**provider call, DB upsert**" (`10-observability-alerting.md:273`). [10 §4](10-observability-alerting.md:200)
carefully guards **metric** cardinality — but [10 §5](10-observability-alerting.md) sets **no sampling
policy for traces**. At the target scale a single large bulk job (50 chunks × ~2 000 rows) with per-row
provider/DB spans is **~100k+ spans per job**, i.e. **billions of spans** across the fleet — X-Ray/OTel
ingestion cost and per-job overhead (span creation + exporter I/O on a concurrency-hot path) that no one
priced. [08 §10](08-migration-strategy.md:536) hand-waves this as "additive + sampled" (Low/Low) without
saying **how** a trace that spans a producer HTTP request and a consumer *minutes later* is sampled
consistently (head-based decisions must be propagated in the `traceparent` sampled-flag; tail-based needs
a collector).

**Recommended revision (10 §5).** Specify **head-based sampling propagated via the `traceparent`
sampled-flag** (decision made once at the producer, honored by the consumer so a trace is whole or
absent). Cap span granularity: **trace at job/chunk level, never per row** — per-row detail belongs in the
three-way accounting counters ([10 §4.3](10-observability-alerting.md)), not spans. Add an explicit
**trace-ingestion cost line** to [11](11-capacity-finops.md) so the observability bill is a budgeted
number, not a footnote.

### F13 — Phase-4 autoscaling gate is incomplete: enqueue-after-commit survives on the fan-out producers under scale-out

**[Target-flaw].** [08](08-migration-strategy.md) correctly orders outbox (Phase 2) before autoscaling
(Phase 4). But the Phase-2 **exit criterion** only requires "**at least one** non-spend producer fully cut
over to the relay" (`08-migration-strategy.md:322`), and the Phase-4 hard gate is "**consumer**
idempotency proven before N>1" (`08-migration-strategy.md:395-399`). Neither requires **all live
*producers*** to be on the outbox. So Phase 4 can scale replicas while most producers — including the
best-effort import fan-outs `void enqueueDedup(...).catch(...)` after commit
(`09-reliability-fault-tolerance.md:271-274`, `register.ts:389-410`) — are still on **enqueue-after-commit**.
Scaling replicas **multiplies the crash surface** of exactly those lost-enqueue producers (the risk 08
names for consumers but leaves open for producers). The non-atomic-enqueue gap therefore **survives into
the scaled target**.

**Recommended revision (08 Phase 2/4).** Add a Phase-4 hard gate: **every live event producer is on the
outbox _or_ carries a documented at-least-once + idempotent-consumer exception with a sweep backstop.**
Explicitly include the import→rollup fan-outs ([09 §6.2](09-reliability-fault-tolerance.md) already scopes
them "at minimum") in the Phase-2 cutover set, not just "one non-spend producer."

### F14 — `/ready` must probe the *blocking consumer* connection post role-split; readiness flap + aggressive restart = a restart storm that loses in-flight work

**[Target-flaw].** The P0 quick win — `/ready` does a Redis `PING`
([10 §6](10-observability-alerting.md), [09 §9.3](09-reliability-fault-tolerance.md)) — is correct in
spirit but under-specified against a *later* recommendation. [07 §4](07-target-architecture.md:237)
splits Redis into **separate connections per role** (blocking consumer vs producer vs throttle). A
`PING` on a **producer/throttle** connection can return `200` while the **blocking consumer** connection
— the one that actually starves under the `maxRetriesPerRequest:null` buffer-forever wedge
([09 §8.1](09-reliability-fault-tolerance.md)) — is dead. Readiness must probe the **consumer's blocking
connection** (or a "last job dequeued within N s" liveness), or it re-creates the exact false-green it
was meant to fix.

Second-order: once the **prod healthcheck restarts on unhealthy** (`08-migration-strategy.md:248`), a
**transient** Redis blip that flaps `/ready` → 503 across **all** replicas triggers a **simultaneous
restart storm**. Pre-outbox (before Phase 2), those restarts **lose in-flight Redis jobs** — turning a
2-second Redis hiccup into fleet-wide job loss.

**Recommended revision (10 §6, 09 §9.3, 08 Phase 1).** Readiness must probe the **blocking** connection
(or a per-worker heartbeat), not any Redis client. Require a **failure threshold** (N consecutive probe
fails over a window) before an orchestrator marks the task unhealthy, to ride out blips. Note the
sequencing dependency: **aggressive restart-on-unhealthy is only fully safe after Phase 2 (outbox)** makes
in-flight work reconstructable — flag it in 08's Phase-1 exit criteria.

---

## P2 — consistency, doc-integrity, and lower-blast issues

### F15 — Temporal is named the target orchestration home but is absent from the plan and contradicts "no rewrite"; the `15-*` cross-refs are self-flagged unverified

**[Target-flaw / doc consistency].** Two loose threads that will confuse an implementer:

1. **Temporal in-vs-out.** [07 §4.2](07-target-architecture.md:273-282) names **Temporal** the "long-term
   home for the bulk state machine" and the durable fix for the `paused`-trap / lost-enqueue class. But
   [08](08-migration-strategy.md) — the sequencing owner — has **no Temporal phase** (Phases 0-5 end at
   multi-region). So either Temporal is in scope (then 08 must add a phase **and** confront that porting a
   *live money-path state machine* off BullMQ+DB-columns onto Temporal is a **rewrite of exactly the path**
   the strangler principle forbids, `08-migration-strategy.md:54-59`), or it is out of scope (then 07 §4.2
   over-promises). The re-audit forces the choice: **keep the near-term outbox fix (07 §5) and mark
   Temporal explicitly deferred/optional** with a revisit trigger, matching how [07 §4.2](07-target-architecture.md)
   treats Kafka. Note also that the **outbox-in-Postgres already provides the durable replay** that 07's
   Kafka trigger (`07-target-architecture.md:270-272`) lists — so the Kafka trigger is *weaker* than
   written and should acknowledge the outbox reduces it.
2. **Dangling plan refs.** [08 §8](08-migration-strategy.md:488-490) itself flags `[NEEDS VERIFICATION]`
   that `15-phased-implementation-plan.md` "was not yet present" and that its phase-heading mapping is
   speculative; multiple docs cross-link `15-*` as the authoritative source of diffs. Until 15 lands, the
   "Strategy Phase 0 + Phase 1 == Plan Phase 0" reconciliation (`08-migration-strategy.md:487`) is
   unverified and the phase↔plan table may break on renumber.

**Recommended revision.** In 07 §4.2, downgrade Temporal from "the long-term home" to "an **optional**
orchestration layer, deferred behind a measured trigger (long-running stateful workflows outgrow
BullMQ+DB state), **not** on the current roadmap." In 08, add a one-line explicit "Temporal: out of the
0-5 roadmap; revisit per trigger." Reconcile the `15-*` mapping once 15 lands and remove the
`[NEEDS VERIFICATION]`.

---

## Final revised recommendations

Threading all fifteen findings, the target architecture ([07](07-target-architecture.md)) and plan
([08](08-migration-strategy.md)) are **directionally right** — the outbox, per-domain tiers, DLQ-everywhere,
autoscale-on-depth/age, and the preserved safe-by-default gates are the correct destination. The
second-pass changes are **not** a redirection; they **remove new failure modes the cure introduces** and
**correct three over-claims**. In priority order:

1. **Resolve the outbox relay's concurrency model once (F1, F2, F6, F9).** Adopt a **leaderless,
   partitioned `FOR UPDATE SKIP LOCKED`** relay (drop the single-leader pin), prefer **CDC** for
   high-volume domains, give the outbox a **per-target delivery column**, and add a **relay-lag SLO**.
   Correct 08's "reuse the daily `projection_sweep` shape" to "reuse only the primitives, run
   continuously." This is the single highest-leverage revision — it fixes a self-contradiction, a
   throughput ceiling, a category error, and a partial-publication gap together.

2. **Make spend safety survive concurrency and failover (F3, F4).** Make the **daily budget breaker
   atomic** (P0, not a lease byproduct); put the **per-batch credit lease (ADR-0029) on the Phase-4
   critical path** as a hard gate before any concurrency increase on the spend path; and restate DR as
   **"duplicate spend bounded by RPO, backstopped by the daily breaker,"** not "zero" — or replicate the
   spend/idempotency ledger at RPO 0.

3. **Give multi-region and scale-out a real mutual-exclusion story (F5, F6).** State that `withLeaderLock`
   is **intra-cluster, fenceless, and not partition-safe**; gate destructive/singleton work on a
   **DB-issued region-role + fencing token**, not a Redis lock; run destructive sweeps only in the active
   region.

4. **Design the fairness and redrive primitives correctly (F7, F8, F10).** Per-tenant caps are
   **TTL-reclaimed concurrency leases**, not refill token-buckets; choose an **OSS application-level
   weighted dispatcher** for tenant fairness (or explicitly budget **BullMQ Pro** and name the
   dependency); make **redrive** skip deterministic poison, cap per-record redrive count, and rate-limit
   itself.

5. **Tame the elastic and observability layers (F11, F12, F13, F14).** Warm **min-replica-1 for T0**,
   add **stabilization windows**, and treat **age-climbing-with-flat-depth as a page, not a scale**;
   specify **head-based propagated trace sampling** and **no per-row spans**, with a budgeted ingestion
   cost; add a Phase-4 gate that **all producers are on the outbox**; and make `/ready` probe the
   **blocking** connection with a **failure threshold**, noting aggressive restart is only safe post-outbox.

6. **Close the documentation loops (F15).** Mark **Temporal deferred/optional** (not "the home"),
   reconcile the `15-*` cross-references once that doc lands.

**The one-line verdict.** None of these findings says "do not build the target." They say: **the outbox
must be leaderless-and-partitioned, the spend backstops must be atomic-and-RPO-honest, the leader lock
must be declared fenceless-and-intra-cluster, and the fairness/redrive/autoscale primitives must be
specified with their crash and pause edges — before, not after, the phase that first depends on each.**
Every fix lands **inside** the existing phase gates of [08](08-migration-strategy.md); this is a
hardening pass on a sound design, and it preserves the corpus's load-bearing framing that the current
darkness is safe-by-default, not broken.

---

### See also

- [06-gap-analysis.md](06-gap-analysis.md) — the intended-vs-built matrix this review's targets extend.
- [07-target-architecture.md](07-target-architecture.md) · [08-migration-strategy.md](08-migration-strategy.md)
  · [09-reliability-fault-tolerance.md](09-reliability-fault-tolerance.md)
  · [10-observability-alerting.md](10-observability-alerting.md)
  · [11-capacity-finops.md](11-capacity-finops.md) · [12-security-review.md](12-security-review.md) — the
  proposals under review.
- [02-root-cause-analysis.md](02-root-cause-analysis.md) — the `paused`-trap / lost-enqueue defects F1/F13
  must not let survive into the target.
- [15-phased-implementation-plan.md](15-phased-implementation-plan.md) — the deferred code work; F15 flags
  the cross-reference reconciliation owed once it lands.
