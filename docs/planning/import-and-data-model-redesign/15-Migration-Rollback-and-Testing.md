# 15 — Migration, Rollback & Testing

> **Status of this doc:** complete (execution doc — deliverables #16 migration + #17 testing +
> #18 rollback, merged deliberately: every migration step names its rollback lever and its test
> gate in the same row, because a step whose rollback and proof live in different documents is a
> step that ships without either).
> **What this doc owns:** the master step sequence (**§M-SEQ**) over every step ID defined in
> docs 04–13, honoring [`07 §8`](07-Data-Model-Relationships.md)'s DDL index and hard ordering
> edges and [`14`](14-Roadmap-Risk-and-Future-Enhancements.md)'s phase spine and 7 conflict
> resolutions; the per-family migration mechanics; the per-phase rollback rehearsals
> (**§R-P0…§R-P5** — the handles 14's risk register points at); and the per-phase test-gate
> bundles (**§T-P0…§T-P5**).
> **What this doc does not do:** re-specify any design or any test (the owning docs' step IDs
> and test IDs are referenced verbatim, never renumbered); own shipped-status (doc `16` only);
> place gates in phases (doc `14` only).

---

## Objective

Turn ten design docs' step IDs into one executable order, where **every row answers three
questions at once**: *what runs next, how it comes back out, and what proves it worked*. The
acceptance test for this doc: every step ID from 04/05/06/08/09/10/11/12/13 appears in §M-SEQ
exactly once with a rollback pointer and a test-gate pointer; every 14 §R-handle and §T-handle
resolves here; every P0–P2 test gate traces to a 02 §Register gap ID (§Gap traceability).

---

## Reconciliation (rules of the road, stated once, binding on every row below)

1. **No fixed migration numbers — ever.** Steps are IDs (`S-*`); **the next free migration
   number is taken at PR time**, per README §Conventions (the import trio is `0032` on disk
   while older docs said 0024 — the renumbering precedent is why this rule exists). Stated here
   once; no row below repeats it.
2. **All DDL is additive. Nothing drops, renames, or repurposes in this program** (07 §8:
   "Everything is additive; no column is renamed or dropped anywhere in this series"). Every
   up-migration ships with a written down-migration (06/10 pre-build mandates), but the down is
   a rehearsed escape hatch, not a rollout plan — the production rollback lever is always a
   flag, never a `DROP` (flag-off wrote nothing ⇒ the down is safe; flag-on wrote data ⇒ the
   down is never run in prod).
3. **Dual-write precedes the final backfill pass** (05 §Implementation's ordering refinement,
   adopted by 14 conflict ⑤ for accounts too): expand → dual-write → backfill (+ re-run to
   close the tail) → verify drift 0 → read-cutover. §M-SEQ encodes the gate between each.
4. **Every new table ships, in the same PR:** its Drizzle schema; `tenant_id`/`workspace_id`
   NOT NULL; the `ENABLE`+`FORCE` RLS policy in the idempotent `packages/db/src/rls/*.sql`
   pattern (`DROP POLICY IF EXISTS` + `CREATE`, applied by `migrate.ts` on every run — the
   shipped defensive-CREATE idiom, `rls/contacts.sql:1–6`); grants to `leadwolf_app`; the
   `set_updated_at` trigger; and its RLS isolation itest. A table without all five is a
   review-rejectable PR (truepoint-security precedence).
5. **The sandbox constraint, stated once:** this environment cannot run bun/docker/CI. **Every
   test gate in this doc is a CI deliverable** — drizzle-kit regen, biome, typecheck,
   `bun test`, itests against real Postgres, and the nightly soaks all run in CI, never
   asserted locally. "Green" below always means "green in CI".
6. **07 §8's hard ordering edges, restated once and encoded in §M-SEQ:** S-CH2 **before** the
   final S-CH3 pass · S-C4 **after** S-CH1–S-CH4 *and* S-A1 + S-A5 · S-A6's ladder rung C2
   **after** S-A1's backfill converges. Plus 14's phase edges: P0→P1 (predicate before
   surfaces), P1→P2, P3→P4 (07 §8's merge edge at phase grain), P2→P5; P2 ∥ P3.
7. **The one sanctioned RLS bypass stays the only one** (07 §5, re-audited by 13 §5): the
   per-job UNLOGGED COPY staging table on the owner connection. **No backfill in this doc uses
   it** — every backfill below runs `withTenantTx` per workspace (§2.1). Any step needing a
   second bypass amends `data-management/15`, not this doc.

### Cross-doc mismatches found while sequencing (rulings, not silent divergence)

| # | Mismatch | Ruling here |
|---|---|---|
| M1 | **Audit-action CHECK packaging.** 07 §8's S-C2 row bundles 05 §7's channel actions (`channel_added`…) into "one CHECK migration at PR time" with `contact.merge`; 08 §7 rides the import lifecycle actions on **S-I9** (Phase 2). But the *first writers* land earlier: S-V4's audited `import_policy` writes are **Phase 0** (10's T-V6 asserts "policy change audited" — a P0 gate); S-I4 writes `import.cancelled` in **Phase 1**; S-CH2 writes `channel_*` in **Phase 3**; S-C2's `contact.merge` is Phase 4 | The `audit_log.action` CHECK is extended **once per phase, in that phase's migration train, with exactly the actions that phase's verbs write**: P0 → the `import_policy`-change action (rides S-V1's migration train, seq 2 — without it T-V6's audited write fails the CHECK at Phase-0 runtime); P1 → `import.committed/.cancelled/.retry_created/.template_saved/.artifact_downloaded`; P2 → `import.draft_reaped`, `import.av_infected`; P3 → 05 §7's four `channel_*` actions; P4 → `contact.merge` (S-C2 proper). "One migration at PR time" is honored *within* each phase; each takes the next free number. The CHECK-extension mechanics are S-C2's in every case (04 §4) |
| M2 | 14 §Testing's summary listed "09 T-Q1–T-Q5" for P1; doc 09 defines **T-Q1–T-Q9**, all of them Phase-1-relevant (T-Q6 notify dedupe = S-Q4; T-Q7 finalize-once; T-Q8 stall detector = S-Q5; T-Q9 priority = S-Q1) | 14 is explicitly summary-level ("15 details them"); §T-P1 carries the complete set T-Q1–T-Q9. *14's summary line has since been aligned to cite T-Q1–T-Q9* |
| M3 | 14's summary put "04 T1–T7" in P4, but T4 (cache↔child invariant) and T7 (ladder extension) test S-C8/S-C6 — **Phase 3** steps per 14's own conflict ⑥ | T4 + T7 gate **Phase 3** (§T-P3); T1/T2/T3/T5/T6 gate Phase 4 (§T-P4), where T4 is re-asserted under merge demotions. *14's summary line has since been aligned to carry the split* |
| M4 | 11's T-U7 (duplicate arc) includes a **merge** leg, but the merge panel is S-U8 — Phase 4 | T-U7's dismiss leg may run from P1; the full arc gates **Phase 4** (§T-P4) |
| M5 | 14's P1 mermaid node omitted S-V5 and S-S4, which 14's Phase-1 body text includes | The body governs; both are Phase 1 in §M-SEQ (they ride S-I7's artifact slice). *14's diagram has since been corrected to include both (and P2's node gained S-S8, same omission class)* |
| M6 | 08 §6.2 says artifacts ship behind "signed expiring URLs"; 13 §4.3 refines to **proxied-with-audit** (presign = bounded fallback) — a refinement 08 itself delegated | S-S4 (proxied delivery) sequences in the same Phase-1 slice as S-I7/S-V5; doc 16 records the resolution when it ships |
| M7 | 05's §Testing is a ten-item list with **no test IDs** | Referenced by name (never renumbered); §T-P3 lists them verbatim |

No step-ID discrepancy was found between the owning docs' Implementation Steps tables and
07 §8's DDL index — the ID sets match exactly (S-CH1–5, S-C1–9, S-A1–6 vs 07 §8; S-I1–10,
S-Q1–8, S-V1–6, S-U1–8, S-P1–5, S-S1–8 vs their owners).

---

## §M-SEQ — the master step sequence

Columns: **Seq** · **Step (doc)** · what it does (one line) · **DDL** (additive/none/seed) ·
**Flag(s)/lever** · **Rollback** (pointer) · **Test gate** (pointer; IDs are the owning docs')
· **CI deliverables** beyond the standing set (regen + biome + typecheck + itest — rule 5).
Preconditions between rows are the arrows in the phase banners.

### Phase 0 — visibility fix + toggle kill (order: S-U1 ∥ (S-V1 → S-V2 → S-V3 → S-V4); S-V6 trails)

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 1 | **S-U1** (11) | Toggle kill (flag-independent) + TanStack adoption + `/imports` route scaffold | none | none (removal is deliberate) | §R-P0 (no lever needed — removes a 403 generator only) | §T-P0: T-U8 (toggle half) | grep gate: `largeFile`/`act-bulk-import` extinct |
| 2 | **S-V1** (10) | Additive DDL: `shared_with_workspace` on 3 job tables · member-list keyset indexes (+ `source_imports` composite) · `import_policy` table · **P0 audit-action CHECK extension (ruling M1: the policy-change action S-V4's audited writes need)** | **additive** | none (unread while flag off) | §R-P0 (DDL stays inert; down written) | §T-P0 | regen; `import_policy` RLS block in `rls/*.sql` (rule 4) |
| 3 | **S-V2** (10) | `JobViewer` + shared `jobVisibility` predicate; repository **renames delete the unpredicated reads** (the G04 hazard disposal, 14 conflict ②) | none | none (compile-time change) | §R-P0 | §T-P0: T-V8 | typecheck IS the gate (signature guard); grep: no `*ByWorkspace` job read |
| 4 | **S-V3** (10) | Viewer wired on all live surfaces (reveal, enrichment, home card, import detail/legacy poll) | none | `JOB_VISIBILITY_SCOPED` + `job_visibility_scoped` (dual gate) | §R-P0 (flag off ⇒ byte-identical) | §T-P0: T-V1–T-V4 | cross-USER itest class added to CI suite |
| 5 | **S-V4** (10) | G02 create grant (`member`+) + `import_policy.who_can_import` + template manage-gates | none | rides S-V3's flag (tenant behavior changes once) | §R-P0 | §T-P0: T-V5–T-V7 | — |
| 6 | **S-V6** (10) | Flag retirement: predicate unconditional, short-circuit branch deleted — **after bake; may trail into Phase 1** | none | none — **this step removes the lever** (entry: cohorts 100 % flipped, reverts = 0, 14 Phase-0 comms done) | §R-P0 (irreversibility note) | T-V4 retired with the branch; T-V1–T-V3 stay forever | — |

### Phase 1 — durable job unification (order: DDL first; S-I3 before every consumer; S-Q3→S-Q4; UI last)

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 7 | **S-I1** (08) | `import_jobs` additive columns (mode, strategy pair, `parent_job_id`, `source_filename`, template FK, options, `preview_summary`) + status-CHECK extension (`draft`/`uploading`/`deferred`) + the keyset index (07 §4.3) + **P1 audit-action CHECK extension (ruling M1)** | **additive** | unread while `IMPORT_V2_ENABLED` off | §R-P1 | §T-P1 | regen |
| 8 | **S-I2** (08) | `import_mapping_templates.visibility` + template strategy block | **additive** | as S-I1 | §R-P1 | §T-P1: T11 | regen |
| 9 | **S-S1** (13) | Upload envelope: magic-byte sniffing, stream byte-count abort, multipart caps, encoding rules, download header pinning (applies to the legacy path too) | none | rides `IMPORT_V2_ENABLED` for the new path; admission-tightening on legacy is deliberate | §R-P1 | §T-P1: T-S7 | admission-matrix fixtures |
| 10 | **S-S5** (13) | Zip-bomb/archive caps on XLSX admission | none | as S-S1 | §R-P1 | §T-P1: T-S2 | bomb fixtures in repo |
| 11 | **S-I3** (08) | Fast-path dual-write: worker wrapper around unchanged `runImport` writes transitions + counter deltas + `import_job_rows`; poll reads the DB row — **G03 closes** | none | `IMPORT_V2_ENABLED` + `import_v2_enabled` (dual gate) — off ⇒ byte-identical | §R-P1 | §T-P1: T1 (parity), T4, T5 | T1 parity harness (golden responses) |
| 12 | **S-Q1** (09) | Unified queue: fast drives/chunks on `bulk-imports` with priority bands; `tuning.ts` + deadline entries | none | rides S-I3's gate | §R-P1 | §T-P1: T-Q9 | tuning tripwire test extended |
| 13 | **S-Q2** (09) | Bounded rolling fan-out (window K=2) + per-workspace cap → `deferred` + leader-locked promotion sweep | none | K env-tunable (K=∞ = legacy enqueue-all) | §R-P1 | §T-P1: T-Q4 | — |
| 14 | **S-Q6** (09) | Counter-delta cadence + shared derivation fn + SSE names reserved in `@leadwolf/types` (wiring dark) | none | rides S-I3's gate; SSE behind `REALTIME_SSE_ENABLED` (untouched) | §R-P1 | §T-P1 (cadence asserted inside T-Q1/T-Q2) | — |
| 15 | **S-I4** (08) | Tenant list/detail/cancel — **hard precondition: S-V2/S-V3 shipped** ("list ships only with 10's predicate"); G04's routed half + G05 cancel | none | list strict from birth; cancel rides S-I3's gate | §R-P1 | §T-P1: T2, T3, T9; T-V1 import row | keyset plan guard (TP-5 row) |
| 16 | **S-P2** (12) | Published limits as config constants + RFC 9457 quota members + limits doc page (G12 launch numbers) | none | constants revert by config | §R-P1 | §T-P1: TP-7 | one-constant-two-consumers assertion |
| 17 | **S-I5** (08) | Server-side routing consumes `BULK_IMPORT_THRESHOLD_ROWS` + byte/XLSX ceilings; honest `file_too_large` pre-gate (G10 routing half) | none | rides S-I3's gate | §R-P1 | §T-P1: T7 (routing/pre-gate half) | — |
| 18 | **S-I6** (08) | Strategy triad `merge_mode`/`preserve_populated` through `planFieldWrite` in both engines + legacy `conflictPolicy` mapping + org-admin default (G13) | none | rides S-I3's gate | §R-P1 | §T-P1: T6 | pin-immunity assertion in T6 |
| 19 | **S-I7** (08) | Artifact pair (repair CSV + error report), typed-code vocabulary, `rejected_artifact_key` write-back | none | rides S-I3's gate | §R-P1 | §T-P1: T8 | — |
| 20 | **S-S3** (13) | Formula-injection neutralizer + `_REDACTED_` pass in the single artifact-writer (same slice as S-I7) | none | as S-I7 (strict from birth) | §R-P1 | §T-P1: T-S1, T-S5 | hostile-cell fixtures |
| 21 | **S-V5** (10) | Artifact gate (creator ∪ elevated, share-flag ignored) + download audit + stricter bucket | none | new endpoint — strict from birth | §R-P1 | §T-P1: T-V7; T-S4 | — |
| 22 | **S-S4** (13) | Proxied artifact download with in-request audit + pinned headers (ruling M6); presign = bounded fallback | none | as S-V5 | §R-P1 | §T-P1: T-S4 | — |
| 23 | **S-I10** (08) | Retry-failed child jobs (`parent_job_id`) + commit quota + deferred shed (promotion rides S-Q2's sweep) | none | rides S-I3's gate | §R-P1 | §T-P1: T10 | — |
| 24 | **S-Q3** (09) | Outbox producers in the terminal/commit tx; drive enqueue → `import.drive` topic; best-effort handlers retired behind the gate — **G06 closes** | none | dual gate — off ⇒ direct enqueue + best-effort handlers return byte-identical | §R-P1 | §T-P1: T-Q3 (both halves) | crash-injection harness |
| 25 | **S-Q4** (09) | `import.notify` publisher + idempotent in-app insert + email seam + delivery-lag metric | none | rides S-Q3's gate | §R-P1 | §T-P1: T-Q6 | — |
| 26 | **S-Q5** (09) | Reaper extension (composes db-mgmt-research/05's lease columns — owned there): Redis-loss re-enqueue, stall detector, artifact re-sweep | none | gate-independent hardening (observe/recover only) | §R-P1 | §T-P1: T-Q5, T-Q8 | Redis-flush drill scripted |
| 27 | **S-Q7** (09) | Metrics + alert catalog + runbook entries (09 §8) | none | gate-independent | §R-P1 | §T-P1 (alert-fires asserted in T-Q8) | runbook entries landed (exit-gate item) |
| 28 | **S-S6** (13) | PII hardening: `reject_reason` writer rule + log lint (+ recommended ledger `input` encryption) | none | gate-independent | §R-P1 | §T-P1: T-S6 | PII-pattern sweep in CI |
| 29–33 | **S-U2 → S-U6** (11) | History page + drawer (S-U2, after S-I4) · durable job page + **poller deletion** (S-U3, after S-I3) · wizard v2 (S-U4, after S-I5/S-I6/S-I2) · notifications UI + card split (S-U5, after S-Q4/S-V3) · error UX + retry dialog (S-U6, after S-I7/S-I10) | none | ride `IMPORT_V2_ENABLED` (card split rides 10's flag) | §R-P1 | §T-P1: T-U1–T-U6; T-U8 (give-up-copy half) | axe + keyboard CI (T-U4); funnel events wired |

### Phase 2 — the three gates clear; copy mode live (order: gates B→C→A per 14; **S-Q8 last**)

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 34 | **S-P5** (12) | `fillfactor=90` on `import_jobs` + per-table autovacuum params on the 4 high-churn tables (may ship any time from P1) | storage params only | `ALTER … RESET` reverts | §R-P2 | §T-P2 (soak observes) | regen (params in schema) |
| 35 | **GATE B (G07)** → **S-I8** (08) | Draft flow: upload-once, `PUT mapping`, preview, auto-map + alias table + in-flow custom-field creation, commit, draft reaper | none | rides `IMPORT_V2_ENABLED`; canary only until Gate C | §R-P2 | §T-P2: T11, T12; Gate-B put→signed-get→expiry itest (08 §8) | non-prod bucket itest |
| 36 | **S-U7** (11) | Draft-flow UI: upload-once, resume, `?step=` deep-link (canary with S-I8) | none | as S-I8 | §R-P2 | §T-P2 (rides T-U6 re-run on draft path) | — |
| 37 | **S-S7** (13) | Artifact lifecycle TTL (90 d) + key-nulling sweep + job-purge prefix deletion + `import_artifacts` class registration | none | config + sweep off | §R-P2 | §T-P2 (lifecycle metric) | — |
| 38 | **S-S2** (13) | **GATE C (G08):** `MalwareScannerPort` + adapter at both wire points + infected terminal path + fail-closed outage + no-new-`skipped` monitor (on, permanently) → **Phase-B GA unblocked** | none | disabling = reverting to the stub, deliberately loud (13 §11) | §R-P2 (no quiet lever, by design) | §T-P2: **T-S3** (EICAR, the G08 clearance test) + outage drill | EICAR fixtures; monitor alert wired |
| 39 | **S-P1** (12) | **GATE A (G09):** COPY spike as CI assertions — 12 §3.2 criteria 1–4 (round-trip · ≥20k rows/s · ≤128 MB plateau · clean mid-stream cancel) in `bulkImport.pipeline.itest.ts`; verdict in an ADR addendum. **Red ⇒ §3.3 batched-INSERT fallback behind the same seam, its own floor measured; ceiling stays 1M** | none | red path = fallback, never a redesign (R01) | §R-P2 | §T-P2: **TP-1** | the spike IS a CI artifact; the 16 §Gate-state COPY-spike row flips on green (01's L6 ledger row follows per §6.2) |
| 40 | **S-I9** (08) | Copy-mode engagement above threshold (A+B+C all green); `/imports/bulk` delegation window; legacy status mapping (08 §2.4); **P2 audit-CHECK extension (M1)** | **additive** (audit CHECK) | graduates the existing `BULK_IMPORT_ENABLED` + `bulk_import_enabled` pair (no new flag — db-mgmt rule 3) | §R-P2 (copy off per-tenant/fleet ⇒ fast path + honest ceiling) | §T-P2: T7 (copy half), T3 full matrix, **T-X2**; db-mgmt-research/05 AC1–AC3 | canary evidence: ≥100k-row real file E2E + idempotency replay (14 exit) |
| 41 | **S-P4** (12) | Nightly 2M soak + concurrent-tenant fairness scenario + poll/ETag probe (fast-path scenario runs from P1) | none | tests only | §R-P2 | §T-P2: TP-2, TP-3, TP-4, TP-6 | nightly job in CI; §5 ceiling raise gated on green |
| 42 | **S-S8** (13) | DSAR extension: pointer-driven ledger `input` scrub + affected-job artifact deletion in `deleteFanout` | none | rides retention track | §R-P2 | §T-P2: T-S8 | — |
| 43 | **S-Q8** (09) | **Legacy `imports` queue retirement: producer switch → drain window → consumer/tuning/DLQ removal. THE irreversible step** — entry conditions in §2.3 step 4 | none | **none after removal** (window re-extends before it; never after) | §R-P2 (irreversibility contract) | §T-P2: drain-zero telemetry + DLQ empty + one retention window; 09 §Success "G06 closed" grep | drain metric dashboards |
| — | **S-P3** (12) | *Conditional, any phase:* `(job_id, row_index)` and/or the duplicate-review partial composite — each **only** on its named route + a measured p95 breach | additive (conditional) | index drop | owning phase's §R | TP-5 re-run on ship | EXPLAIN plan guard |

### Phase 3 — multi-value channels (order: strict; **∥ Phase 2** — neither blocks the other)

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 44 | **S-CH1** (05) | `contact_emails` + `contact_phones`: full 05 §1–§2 column/constraint/index sets, RLS + grants + triggers, retention-class seed rows (`ttlDays: null`, shadow) + **P3 audit-CHECK extension — the `channel_*` actions land here, before their first writer S-CH2 (ruling M1)** | **additive** | none (dead schema) | §R-P3 (droppable while unwritten) | §T-P3: RLS itests ×2 tables | regen; two `rls/*.sql` blocks (rule 4) |
| 45 | **S-CH2** (05) | Dual-write via `applyChannelWrite` — the **only** writer of child rows *and* flat cache; enrichment/verification writers migrate onto it | none | `CHANNEL_DUAL_WRITE` env kill-switch — off ⇒ shipped write path byte-identical | §R-P3 | §T-P3: dual-write parity test; CH-INV-1 property test | parity harness |
| 46 | **S-CH3** (05) | Backfill flat → primary child rows (email bytes verbatim, phones re-derive E.164); **runs, then re-runs after S-CH2 has been on, to close the write-gap tail**; mechanics §2.1 | none | job-level flag + per-workspace batch control; re-runnable, non-destructive | §R-P3 | §T-P3: backfill idempotency (twice = once; interrupt + rerun; ciphertext equality) | completeness query = 0 is the S-CH4 precondition |
| 47 | **S-CH4** (05) | Read cutover: dedup/reveal/search/export resolve from children; repair direction flips child-wins — **preconditions: completeness = 0 AND drift = 0** | none | `CHANNEL_READ_FROM_CHILD` env — off ⇒ reads return to flat, **nothing lost** | §R-P3 | §T-P3: dedup-extension, collision-policy, masked-contract, E.164 tests; **T-X3** | — |
| 48 | **S-CH5** (05) | Permanent CH-INV-1 reconcile sweep + drift metric/alert (§3 — a fixture, not scaffolding) | none | job off (but never post-cutover in steady state) | §R-P3 | §T-P3 (drift = 0 for a full cycle = the P3 exit gate) | drift alert wired |
| 49 | **S-C8** (04) 🌒 SUBSUMED→S-CH5 (16) | Cache↔child reconcile sweep for the merge-facing invariant (pairs with S-CH5) — **subsumed by the permanent S-CH5 CH-INV-1 sweep; not rebuilt** | none | gated repair verb | §R-P3 | §T-P3: T4 (ruling M3) — covered by S-CH5 itests | — |
| 50 | **S-C6** (04) 🌒 built, dark (16) | Ladder extension: any-value email resolve (**shipped by S-CH4**) + phone-signal + cross-key email-collision → `duplicate_of_contact_id` SUGGESTIONS in `runImport`; **bulk-staging equiv blocked** (bulk COPY not channel-instrumented) | none | rides S-CH4's flag | §R-P3 | §T-P3: T7 (ruling M3) | — |
| 51 | **S-C7** (04) 🌒 SUBSUMED→S-CH4 (16) | Masked-DTO channel summary + read projection — **subsumed by S-CH4; not rebuilt** | none | rides S-CH4's flag | §R-P3 | §T-P3: masked-contract test — covered by S-CH4 itest | — |
| 52 | *(no ID)* | Import mapping channel slots — an increment on S-U4's shipped grid (08 §3 slots, 11 §W2) + 12 §9 projection-contract fields on the dev `SearchPort` adapter (the G16 guard made testable) | none | rides S-CH4's flag | §R-P3 | §T-P3 (zero-values-dropped assertion) | — |

### Phase 4 — company completeness + true merge + resolution UX (order: 06 family → 04 DDL → merge → UI)

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 53 | **S-A1** (06) | `account_domains` table + uniques + RLS; **backfill pass 1** (one primary row per domained account, idempotent) | **additive** | none (unread pre-S-A6) | §R-P4 | §T-P4: RLS itest; backfill idempotency | regen; `rls/*.sql` block |
| 54 | **S-A2** (06) | Account dual-write (child + cache, one tx); cache authoritative until S-A6 | none | writer revert; cache remains authoritative | §R-P4 | §T-P4 (parity: flag-off account writes byte-identical) | — |
| 55 | **S-A1 re-run** | The **backfill re-run after S-A2 is live** — closes the write-gap tail (14 conflict ⑤; not a new step ID, the second pass 06 S-A1 itself mandates) | none | re-runnable | §R-P4 | completeness query = 0 (accounts with `domain` and no child row) — the S-A6/C2 precondition (07 §8 edge) | — |
| 56 | **S-A3** (06) | `account_locations` + RLS; best-effort HQ backfill (unmappable country → NULL) | **additive** | none | §R-P4 | §T-P4: RLS itest; backfill idempotency | regen; `rls/*.sql` block |
| 57 | **S-A4** (06) | `parent_account_id` + `root_account_id` + `uniq_accounts_ws_id` + **composite same-workspace FK** + self-parent CHECK + root index | **additive** | none (hierarchy starts empty) | §R-P4 | §T-P4: cycle tests; composite-FK cross-workspace insert fails | regen |
| 58 | **S-A5** (06) | `accounts.deleted_at` (G18) + online swap of `uniq_accounts_ws_domain` → live-only partial (create-new → drop-old) + live-only partials on list/search indexes | **additive** (online index swap) | swap-back written | §R-P4 | §T-P4: tombstone semantics; ladder matches live-only | regen |
| 59 | **S-A6** (06) | Per-tenant read cutover: `domains[]`/`locations[]`/hierarchy in API; **ladder rung C2 activates — precondition: seq 55 converged** (07 §8 edge) | none | per-tenant dual-gate (named at PR time) — off ⇒ byte-identical account API | §R-P4 | §T-P4: flag-off byte-identity; ladder property tests | — |
| 60 | **S-C1** (04) | `contacts.merged_into_contact_id` (self-FK) + `merged_at` + partial index | **additive** | none (unwritten while merge flag off) | §R-P4 | §T-P4 | regen |
| 61 | **S-C2** (04) | Audit CHECK + `auditAction` enum: `contact.merge` + scalar-edit audit-metadata contract (**P4's CHECK extension — ruling M1**) | **additive** (CHECK) | enum value inert while unwritten | §R-P4 | §T-P4 | regen |
| 62 | **S-C3** (04) | Seed `contact_merge_enabled` (off) + `CONTACT_MERGE_ENABLED` env (dual gate; surfaces in the shipped flag console) | seed | the gate itself | §R-P4 | §T-P4 | — |
| 63 | **S-C4** (04) | Core merge engine — plan via `planFieldWrite`/`planUserEdit` + tx executor with the §3.4 inventory; **preconditions: S-CH1–S-CH4 ✓ (P3 exit) AND S-A1 + S-A5 ✓** (07 §8's hard edge); G23 mitigation 1 (tidy-on-merge re-points `record_tags`) rides it | none | dual gate off ⇒ engine never constructed; **executed merges are not rolled back** (§R-P4) | §T-P4: **T1** (inventory), T2, T3, T5, T6; T4 re-run | T1 = the standing guard for future child tables |
| 64 | **S-C5** (04) | `POST /contacts/:id/merge` + preview + DTOs | none | rides the merge gate | §R-P4 | §T-P4: T5 (replay), T2 (IDOR) | — |
| 65 | **S-C9** (04) | Surface-1 maker-checker wrapper on the **same** engine (supersedes grain-A for value-moving) | none | rides the merge gate + maker-checker | §R-P4 | §T-P4 (approval-flow itest, Surface-1 suite) | — |
| 66 | **S-U8** (11) | Duplicate-review queue under Data Health + side-by-side merge panel + company-match tab (G21) | none | rides the merge gate | §R-P4 | §T-P4: **T-U7 full arc** (ruling M4) | — |
| 67 | *(no ID)* | G23 mitigations 2–3: retention-purge tidies `record_tags`; nightly orphan detector joins 06's detector family | none | detector off | §R-P4 | §T-P4: detector invariants (0 cycles/drift/orphans) | detector alerts wired |

### Phase 5 — import platform extensions

| Seq | Step | What | DDL | Flag(s) | Rollback | Test gate | CI deliverables |
|---|---|---|---|---|---|---|---|
| 68+ | *(minted at design time)* | Scheduled · delta/`external_id` (additive unique, sketch 08 §9) · API-push — each gets its own step IDs, brief, and 13 §8's SSRF acceptance criteria; none exists yet by 08's rule | per brief | per-extension dual-gates | §R-P5 | §T-P5 | doc 16 gains rows as they ship |

**Sequence-shape summary:** 6 P0 steps → 27 P1 steps (the widest band) → 10 P2 steps ending in
the one irreversible retirement → 9 P3 steps in a strict expand→dual-write→backfill→cutover
chain → 15 P4 steps in two internally-ordered families converging on S-C4 → open P5. Total
sequenced: **all 65 defined step IDs** (9 S-C · 5 S-CH · 6 S-A · 10 S-I · 8 S-Q · 6 S-V ·
8 S-U · 5 S-P · 8 S-S; S-P3 sequenced as trigger-conditional) plus 3 no-ID riders and the
mandated S-A1 re-run.

---

## §2 Migration mechanics per family

### §2.1 Channel backfill (S-CH3) — the mechanics, pinned

05 decided the shape; restated here as the executable contract, not re-decided:

- **Connection & RLS posture:** the backfill worker runs **`withTenantTx` per workspace** —
  never the owner connection (rule 7; the sanctioned owner-conn pattern is COPY staging only,
  07 §5). The worker enumerates workspaces from the system side, then opens one scoped tx per
  batch inside each workspace. RLS is therefore *enforcing* during backfill, not bypassed.
- **Iteration:** leader-locked job (the house sweep idiom); per-workspace **keyset walk over
  `contacts.id`** (uuid v7 ⇒ time-ordered, stable cursor), batches of **1 000 contacts**, one
  tx per batch, each batch commits — no long transactions, no table locks beyond row-level,
  ordinary MVCC. Off-peak schedulable; per-workspace batch control knob (05's flag row).
- **Writes:** contacts with a flat email/phone and no live child row get one `is_primary=true`
  row each — **email ciphertext + blind index copied byte-verbatim (no re-encrypt, no
  re-normalize — CH-INV-1 holds by construction)**; phones decrypt in-worker → `toE164` (hint
  from `locationCountry`, else raw-only) → populate `e164_*`. Idempotent via
  `ON CONFLICT DO NOTHING` on the 05 §2.2 partial uniques ⇒ re-run twice = run once.
- **Resumability:** progress watermark = `(workspace_id, last contact id)` persisted per batch
  commit; a crash resumes from the watermark; a full re-run is also always safe (idempotency).
  **Abort:** a job-level kill flag checked at every batch boundary; abort leaves a consistent,
  partially-backfilled state that is *invisible to users* (see §2.1's guarantee below).
- **Instrumentation:** counters — workspaces completed / contacts scanned / child rows created
  / phones-unparseable / conflicts-skipped; a progress gauge per workspace; the stall alarm
  reuses 09 §8's no-movement detector shape.
- **Verification query (the S-CH4 gate):** `count(contacts WHERE deleted_at IS NULL AND
  (email_blind_index IS NOT NULL AND no live contact_emails row … OR phone analog))` — the
  05 §Success "backfill completeness" number. **S-CH4 does not flip until it reads 0** after
  the post-dual-write re-run, *and* the S-CH5 drift metric reads 0.
- **No-partial-visibility guarantee:** because reads stay on the flat columns until S-CH4, a
  half-done (or wedged, or aborted) backfill has **zero user-visible effect** — the child rows
  are dark data until the cutover gate passes. This is the property that makes the whole
  family boring, and it is why the order (dual-write → backfill → verify → cutover) is a hard
  edge, not a preference.

### §2.2 Accounts family (S-A1/S-A2 + the mandated re-run)

Same discipline, smaller scale (one row per domained account, not per contact): S-A1's pass 1
may run at table-create time; **the re-run after S-A2 is on is mandatory** (14 conflict ⑤ —
accounts written between pass 1 and dual-write-on would otherwise lack child rows). Same
keyset/batch/idempotency/watermark mechanics as §2.1; verification query = accounts with
`domain IS NOT NULL` and no live `account_domains` row = 0, gating S-A6's C2 rung (07 §8).
S-A3's HQ backfill is best-effort by design (unmappable country → NULL — recorded honesty,
06 §3); its verification is count-only, never a gate.

### §2.3 Import-path migration — legacy Redis path → durable trio

The compatibility window (08 §1.2), sequenced:

1. **Both paths live (Phase 1, dual-gated).** Flag on: every `POST /imports` creates the
   durable row *and* runs the unchanged `runImport`; the poll endpoint reads the row; legacy
   response shapes preserved via 08 §2.4's status mapping (`cancelled → failed` +
   `failedReason:"cancelled"` for old clients). Flag off: byte-identical legacy behavior
   (T1 is the proof, not a promise). Rows still travel in the BullMQ payload — the Phase-A
   transport bound (12 §2.4) is why the threshold cannot rise yet.
2. **Cutover criteria (open → close, 14 conflict ④):** the window *opens* at Phase 1 and
   *cannot close* before G07. Closing requires: `import_v2_enabled` at 100 % of tenants;
   Phase B live (payload slims to `{jobId, scope}`); retirement date announced at Phase-2
   entry with ≥ 1 release of notice (14's binding answer to 08's assumption 4); legacy-poll
   read traffic ≈ 0 (telemetry on the Redis-backed read).
3. **Drain (S-Q8's own ladder, 09 §1.4):** producer switch first (both consumers live +
   idempotent ⇒ a mid-drain flip-back loses nothing) → consumer registered one more release →
   `IMPORTS_DLQ` empty + one retention window → registration/tuning/producer module deleted.
4. **S-Q8 = the program's one irreversible retirement.** Entry conditions (per 14 R07 and this
   doc's §R-P2): drain-zero telemetry sustained; DLQ archived; no `bulk/:jobId` delegate
   traffic; the announced date passed. After removal there is no return path — which is
   exactly why it is sequenced dead last in Phase 2 and why its "rollback" row reads *none*.

### §2.4 Visibility dual-gate migration (S-V*)

Flag-off byte-identity is the migration mechanism itself: S-V1's DDL is unread when off;
S-V2's renames are behavior-neutral (the predicate short-circuits to workspace-wide when the
flag is off — T-V4 proves byte-identity per surface); the cohort flip is
internal → new-tenants-default-on → staged tenant cohorts **with 14's Phase-0 comms**
(narrowing live visibility is a communicated product change, never a silent fix); S-V6 deletes
the branch only after cohorts = 100 % and steady-state reverts = 0. New surfaces (import list,
artifacts, policy) never had a legacy mode — strict from birth, no migration at all.

---

## §3 Dual-write correctness — the permanent fixtures

These are not migration scaffolding; they run **forever**:

| Fixture | What it checks | Alert threshold | Repair direction |
|---|---|---|---|
| **S-CH5 sweep** (05 §3.4) | CH-INV-1: flat channel columns ≡ the live `is_primary` child row (blind-index + status compare), per workspace, keyset batches | drift > 0 after burn-in = **S2**; a spike = writer-bug signature (05 §worst-case) | **Phase rule, restated from 05 — the job never guesses:** *flat wins* while S-CH2/S-CH3 are the world (flat is still authoritative); *child wins* from S-CH4 on. The direction is read from the flag state, and every repair writes an audit row |
| **S-C8 sweep** (04) | The merge-facing cache↔child invariant after demotion/promotion sequences | count > 0 = S2; blocks merge-canary widening (04 §Rollout) | same phase rule (it reads the same flags) |
| **06 nightly detector family** | 0 cycles · 0 account cache drift · 0 orphaned children under tombstones · `root_account_id` ≡ fresh walk | any nonzero = S2 | accounts phase rule: *cache wins* until S-A6, *child wins* after (06 §pre-build) |
| **record_tags orphan detector** (07 §7, seq 67) | assignments whose `(entity, record_id)` resolves to no live row | > 0 = alert; trending nonzero = the F09 trigger (14) | tidy-verbs only (merge/purge); never auto-delete outside them |
| **Accounting-identity check** (09 §8) | 7-bucket identity on every terminal job | any violation = **S1** (data integrity) | none — a violation is a bug, not a repairable drift |
| **No-new-`skipped` monitor** (13 §2.3) | no production upload ever records `av_scan_status='skipped'` post-S-S2 | any new row = **S2 security** (the G08 gate failing open) | none — investigate wiring |

The two reconciliation sweeps double as the rollback-integrity instruments: after any §R-P3/§R-P4
flag reversal, their zero-reading is the "state is coherent" proof (§R sections below).

---

## §4 Rollback per phase — §R-P0 … §R-P5

Format per phase: **levers** · **not rollback-able** · **the rehearsal** (a concrete drill CI
or staging actually runs — 14's mandate: *a phase does not flip its per-tenant flag for
external tenants until its rehearsal has actually been executed*; drills owed ≠ drills done) ·
**post-rollback integrity checks**.

### §R-P0 — visibility

- **Levers:** `JOB_VISIBILITY_SCOPED` off = instant fleet-wide return to workspace-wide
  visibility, byte-identical (T-V4); `job_visibility_scoped` off per tenant = granular revert.
  S-V1 DDL stays inert either way (columns unread, `import_policy` unenforced).
- **Not rollback-able:** S-V6 (the branch deletion) — after it the predicate is unconditional;
  that is why S-V6's entry conditions are cohort-complete + reverts-zero + bake.
- **Rehearsal (staging):** flip the tenant flag on → run the T-V1 probe set (member A vs B on
  all four surfaces) → flip off → **diff live-surface responses against recorded flag-off
  golden baselines; assert byte-identity** → flip back on. Time-boxed; scripted; the script is
  the artifact CI re-runs on any predicate change.
- **Post-rollback checks:** zero residual 403s on create verbs (the G02 gate rode the same
  flag); `import_policy` rows untouched; audit rows from the drill present (flag flips are
  audited); cross-*tenant* itests still green (the tenant wall never moved).

### §R-P1 — durable job unification

- **Levers:** `IMPORT_V2_ENABLED` (env, fleet) / `import_v2_enabled` (per-tenant) off ⇒ legacy
  direct enqueue + best-effort handlers return, byte-identical (T1 + T-Q3's flag-off half).
  **Executed imports keep their durable rows — data is never rolled back by a flag** (08
  §Rollout). Outbox rows written while on drain harmlessly after a flip-off (consumers
  idempotent, 09 §Rollout). Tuning knobs (K, caps) revert by env.
- **Not rollback-able:** nothing in P1 (deliberately — the widest phase is the safest).
- **Rehearsal (staging):** (a) *mid-flight flip drill* — commit a v2 import, flip the env
  kill-switch off while it runs, assert: the in-flight job reaches a terminal state with the
  accounting identity intact, subsequent submits take the legacy path, no orphan outbox intent
  older than the relay SLA; flip back on, assert the durable row is still listable. (b) the
  **Redis-flush drill** (T-Q5) executed by hand once in staging even though CI automates it —
  the operator runbook is part of the rehearsal.
- **Post-rollback checks:** accounting identity = 0 violations across all terminal jobs;
  `worker_outbox` has no `pending` rows older than SLA; the legacy poll answers for a job
  created pre-flip (via the row, mapping intact); no duplicate notifications (T-Q6 invariant).

### §R-P2 — bulk gates + copy mode

- **Levers:** copy mode off per-tenant or fleet-wide (`bulk_import_enabled` /
  `BULK_IMPORT_ENABLED`) ⇒ fast path + honest `file_too_large` ceiling — the Phase-1 posture,
  which is the program's standing fallback (14 §Standing fallback). Draft flow off via the
  `IMPORT_V2` pair. Scanner: **no quiet lever by design** — reverting S-S2 means reverting to
  the stub and the no-new-`skipped` monitor fires (13 §11); per-tenant copy-off is the
  triage lever for AV false-positive storms (R06). S-P5 params `RESET`. Store/lifecycle:
  objects stay; quotas/ceilings throttle (R05).
- **Not rollback-able:** **S-Q8 after removal** (the return path no longer exists — §2.3
  step 4); **stored objects as source-of-truth** once Phase B is GA (rollback = stop creating
  drafts, never un-store); the raised published ceiling once announced (lowering it is a
  product decision with comms, not a flag flip).
- **Rehearsal (staging):** the **drain-and-retire checklist** executed end-to-end *with a
  deliberate mid-drain flip-back*: switch the producer to the unified queue → verify legacy
  depth drains to zero → **flip the switch back** → assert both consumers processed
  idempotently and nothing was lost (09 §1.4's claim, proven) → re-switch → complete the
  drain → archive DLQ. Plus: the **EICAR fail-closed drill** (scanner down ⇒ nothing admitted;
  restore ⇒ retried drives complete) and a **copy-off drill** (tenant flipped to fast ceiling
  mid-day; over-threshold submits get the honest 413, in-flight copy jobs finish).
- **Post-rollback checks:** zero jobs stranded non-terminal after a copy-off; staging tables
  dropped (no UNLOGGED leftovers — count = 0); accounting identity holds on every job that
  spanned the flip; `file_too_large` problems carry the correct (lowered) limits from the one
  constant set (TP-7's invariant).

### §R-P3 — channels

- **Levers:** `CHANNEL_READ_FROM_CHILD` off ⇒ reads return to flat — **still
  dual-write-maintained, secondaries merely invisible, nothing lost** (05/R02);
  `CHANNEL_DUAL_WRITE` off ⇒ the shipped write path, byte-identical (parity test); backfill
  re-runnable/abortable (§2.1); S-CH1 droppable only in the never-written case.
- **Not rollback-able:** nothing destructive exists in this phase (the family's design goal).
  The one caution: after *long* periods with dual-write off, child rows staleness accrues —
  re-entry is "re-run S-CH3 + drift-0" again, not just a flag.
- **Rehearsal (staging, on a copied workspace):** the **cutover-reversal drill** — S-CH4 on →
  serve reads (record samples) → **S-CH4 off** → assert flat reads byte-identical to
  pre-cutover baselines *and* the S-CH5 sweep's repair direction flipped back to flat-wins →
  S-CH4 on again → **T-X3**: secondary-row count identical, drift returns to 0 within one
  sweep cycle, zero values lost. Plus a **backfill wedge drill**: kill the backfill mid-batch
  on the largest copied workspace, assert watermark resume converges and the completeness
  query monotonically decreases.
- **Post-rollback checks:** CH-INV-1 holds (sweep = 0) in whichever direction the flags now
  point; per-contact channel counts unchanged across the flip pair; no `contact_emails`
  workspace-unique violations surfaced (the partial uniques never relaxed).

### §R-P4 — company + merge

- **Levers:** `CONTACT_MERGE_ENABLED` + `contact_merge_enabled` off ⇒ the marker-only world
  returns (verb 403s, engine never constructed); S-A6's per-tenant gate off ⇒ byte-identical
  account API (06's flag-off test); S-A2 writer revert ⇒ cache-only writes.
- **Not rollback-able:** **executed merges** — irreversible by design (04 §3.6; 14 R04: no
  unmerge exists anywhere in the market). The lever is *stopping new merges*, never unmerging;
  the controls are entry conditions, not recovery: preview + explicit confirm, 2-record cap,
  per-workspace daily cap, canary tenants, pins structurally immune via `planFieldWrite`, T1's
  inventory guard. In-extremis repair = the support runbook (re-create from `source_imports`
  provenance + the audit payload's full pre-merge state) — a runbook, not a product verb.
- **Rehearsal:** (a) the **merge-executor incident tabletop** (14 R-P4 mandate): a simulated
  wrong-pair-merge report walks: audit-event retrieval → pre-merge state reconstruction from
  the event payload (loser's `field_provenance` map + re-point tallies) → provenance-driven
  repair steps → caps/flag-off decision tree — with the on-call runbook as the script and a
  timed target; (b) an **S-A6 flip drill** (off → API byte-identity vs baseline → on); (c) a
  staging **merge-then-flag-off drill**: execute one canary merge, flip flags off, assert the
  merged pair stays merged (tombstone + pointer intact), markers still resolvable, nothing
  half-reverts.
- **Post-rollback checks:** 06 detector clean (0/0/0/100 %); T1's sweep-as-metric = 0 Class-A
  rows referencing any tombstoned loser; zero pinned-field overwrites (audit-derived); the
  duplicate-review queue renders markers again (dismiss-only) with no dangling references.

### §R-P5 — extensions

Per-extension flag off; scheduled sweeps stop cleanly at the leader-lock boundary (no partial
tick); API-push retires by key revocation + 410 window. Each extension's design brief must
ship its own §R drill *before* its flag flips for external tenants — the uniformity bar
(10 §5's invariant applied to rollback). No extension may introduce an irreversible step
without a named entry-condition list in this doc's format.

---

## §5 Testing strategy

### §5.1 The test architecture (the ongoing shape, tier by tier)

**Unit (pure, fast, per-PR):**
- Zod schema evolution: `maskedContactSchema` channel summary never carries a value or a
  secondary domain (extends `contacts.test.ts` guards, 05); `canonicalContactRowSchema`'s
  additive arrays absent ⇒ byte-identical parse (04 §6).
- E.164 pipeline determinism: `blindIndex(toE164(…))` stable; unparseable-kept-raw;
  country-hint resolution order; extension extraction (05 §Testing).
- **`planFieldWrite` × child-provenance interplay:** the strategy triad (S-I6), the merge
  planner (S-C4), and the channel primary-flip rules (05 §3.2–3.3) all compose the same pure
  planner — property tests assert: a pinned winner-map entry survives every
  `merge_mode`/`preserve_populated` combination, every merge decision set, and every
  automated primary-demotion proposal; appending a secondary never consults the winner-map.
- Formula-injection neutralizer: hostile-cell corpus + legitimate-negatives round-trip (T-S1's
  unit core).
- State-machine legality matrix as a table-driven unit test (every illegal transition → 409)
  — the shared contract with db-mgmt-research/05 AC5.

**Integration/itest (real Postgres, CI only):**
- **RLS on every new table** — cross-*tenant* AND the **new cross-USER class** doc 10
  introduced (T-V1: same workspace, different members — the class the shipped suites never
  had); unset-GUC = 0 rows; the composite parent FK rejects cross-workspace inserts (06);
  the staging-predicate test stays mandatory (08 T2 keeps db-mgmt-research/05 §11's).
- Idempotent chunk replay (T-Q1) · cancel-mid-chunk (T-Q2) · outbox same-tx crash-injection
  (T-Q3) · finalize exactly-once (T-Q7) · notify dedupe (T-Q6).
- CH-INV-1 property test over `applyChannelWrite` op sequences · the make-primary **swap
  race** (two concurrent → one primary, one 409) · backfill idempotency
  (twice = once; interrupt + resume; ciphertext byte-equality) — all 05.
- Cycle guard: self-parent, 2-cycle, 10-deep accepted, 11-deep rejected, merge-created cycle
  rejected, concurrent A→B/B→A race detector-clean (06).
- Merge inventory completeness (04 T1 — the standing guard: a future child table without a
  merge rule fails loudly).
- **RLS-coverage meta-test (new, T-X6):** an introspection itest asserting every table
  carrying `workspace_id` has `ENABLE`+`FORCE` RLS and a workspace-isolation policy — rule 4
  made mechanical, so the next table cannot ship bare.

**E2E (CI browser suite):** wizard happy path + partial success + retry-failed-rows (T-U6's
arc), duplicate-review resolve (T-U7, P4), draft resume (S-U7 re-run of T-U6), a11y/keyboard
(T-U4).

**Load (nightly, never per-PR):** the COPY spike criteria as standing assertions (TP-1); the
2M soak (TP-2) with stage budgets; concurrent-tenant fairness (TP-3 over T-Q4's seed); counter
contention + poll/ETag probe (TP-4); constant-memory drive (TP-6); plan guard (TP-5).

**Security (CI + review):** IDOR probes — foreign-user detail/cancel/retry/artifact ⇒ 404
indistinguishable from absent (T-V3, T-S4); artifact access + download-audit completeness
(T-V7); zip-bomb fixture family (T-S2); the scanner-wired itest (T-S3 EICAR, both wire
points + fail-closed); enumeration (uniform 404 shape/timing, opaque cursors — 13 §6);
never-PII sweep over ledger/histogram/DLQ/problems/events (T-S6); redaction (T-S5).

### §5.2 Genuinely new cross-doc tests (this doc's additions — T-X namespace; everything else above is referenced, never re-specified)

| ID | Test | Spans | Phase |
|---|---|---|---|
| **T-X1** | **Legacy-vs-durable cutover parity:** the same CSV fixture through the flag-off legacy path and the flag-on v2 fast path ⇒ **identical contact/account/`source_imports` end-state** (DB-level diff), identical legacy-shaped poll responses via the 08 §2.4 mapping. 08 T1 proves flag-off byte-identity of the *request*; this proves cross-*path* outcome identity — the actual cutover claim | 08+09+10 | P1; re-run at every window change |
| **T-X2** | **Fast-vs-copy outcome parity at the threshold boundary:** one fixture just under and (padded) just over `BULK_IMPORT_THRESHOLD_ROWS` ⇒ identical final overlay outcomes incl. the strategy triad and channel arrays — extends the shipped bulk-vs-sync parity in `bulkImport.pipeline.itest.ts` (data-management/14 §6.4) to the unified engine + 05's channel staging | 08+12+05 | P2 (gates S-I9) |
| **T-X3** | **Post-rollback re-cutover integrity:** S-CH4 on → off → on (and S-A6 analog): zero channel/domain rows lost, drift returns to 0 within one sweep cycle, flat reads during the off-window byte-identical to pre-cutover — the §R-P3 drill as a repeatable CI assertion | 05+06 | P3/P4 |
| **T-X4** | **Import ↔ merge interplay:** import (preserve_populated) into a merged survivor carrying pinned scalars + pinned child rows ⇒ pins hold, demoted-secondary provenance (`first_seen_at`, `source`) survives, re-import of the loser's old identity keys resolves to the survivor (tombstone + child-value uniques), no duplicate mint | 04+05+08 | P4 |
| **T-X5** | **Whole-arc accounting across cancel + retry chain:** parent import cancelled mid-run (`partial`, remainder `unprocessed`) → retry-failed child completes ⇒ parent ∪ child ledgers reconcile to the original `rows_total` with no row double-processed (child processes exactly the failed+unprocessed set) | 08+09 | P1 |
| **T-X6** | **RLS-coverage meta-test** (§5.1) — every `workspace_id` table has FORCE'd isolation | db-wide | P0, forever |

### §5.3 §T-P0 … §T-P5 — the per-phase gate bundles

Each bundle = the set that must be green in CI before that phase's **exit gate** (14) is
claimable and before its per-tenant flag widens beyond canary. IDs are the owning docs',
verbatim (rulings M2–M4 applied).

| Bundle | Blocks (flag/step) | Contents |
|---|---|---|
| **§T-P0** | `job_visibility_scoped` cohort flips; S-V6 entry | 10 **T-V1–T-V8** (T-V4 = the rollback lever proven) · T-U8 toggle half · **T-X6** · repo grep: no unpredicated job-list read compiles (10 §4.2 rule 1) |
| **§T-P1** | `import_v2_enabled` cohort flips; S-Q3/S-Q4 tenant flip (T-Q3 specifically, per 09 §Rollout) | 08 **T1–T12** (T7 routing/pre-gate half; T12 with S-I8 deferred to P2 where drafts exist — draft-reap logic unit-tested in P1) · 09 **T-Q1–T-Q9** (complete set, ruling M2) · 13 **T-S1, T-S2, T-S4, T-S5, T-S6, T-S7** · 12 **TP-4, TP-7** + S-P4's fast-path soak scenario · 11 **T-U1–T-U6** + T-U8 give-up-copy half · **T-X1, T-X5** |
| **§T-P2** | copy-mode graduation (`bulk_import_enabled` cohorts); Phase-B GA; S-Q8 entry; the §5 ceiling raise | 12 **TP-1** (= S-P1; the 12 §3.2 criteria 1–4 as CI assertions — the G09 artifact) · 13 **T-S3** (EICAR — the G08 artifact) + the fail-closed outage drill · db-mgmt-research/05 **AC1–AC3** (inherited so the two series cannot diverge on "done" — 14 entry gate) · Gate-B put→signed-get→expiry itest (08 §8) · 12 **TP-2 (2M soak), TP-3, TP-5, TP-6** · 08 **T7** copy half + **T3** full matrix + **T12** · 13 **T-S8** · **T-X2** · S-Q8 drain-zero evidence |
| **§T-P3** | `CHANNEL_READ_FROM_CHILD` (S-CH4) flip; S-CH2 tenant canary; P4 entry | 05 §Testing, by name (ruling M7): RLS isolation ×2 tables · CH-INV-1 invariant property · swap race · dual-write parity · backfill idempotency · E.164 pipeline · collision policy · dedup-extension (secondary-email resolve) · masked-contract — plus 04 **T4, T7** (ruling M3) · zero-values-dropped import assertion (05 §Success) · **T-X3** · the two hard numeric gates: completeness = 0 and drift = 0 for a full production cycle |
| **§T-P4** | `contact_merge_enabled` canary → widening; S-A6 cohort flips | 04 **T1, T2, T3, T5, T6** (+ T4 re-asserted under merge demotions) · 06 §Testing by name: RLS itests incl. composite-FK cross-workspace insert · ladder property tests (C1≡C2, freemail, ambiguity→review, tombstones never match, within-file collapse) · cycle tests · detector invariant queries · S-A1/S-A3 backfill idempotency · S-A6 flag-off byte-identity — plus 11 **T-U7** full arc (ruling M4) · **T-X4** · the merge security review (a gate, not a test — 14 P4 entry) |
| **§T-P5** | each extension's flag | minted with each extension brief; the floor every bundle must include: a T-V1-class cross-user isolation run on its surfaces, the accounting identity, S-P2 limits enforcement, and 13 §8's SSRF criteria where URLs/credentials appear |

### §5.4 CI gates — what blocks what (and what CI owes that this sandbox cannot run)

- **Standing per-PR set (every step above):** drizzle-kit regen clean (schema ↔ migrations in
  sync — the regen is a CI job because the sandbox cannot run bun; a PR with hand-edited
  migration SQL and stale snapshots fails here) · biome · typecheck (which *is* the S-V2/T-V8
  signature gate) · the itest suite on real Postgres · the T-S6 PII sweep.
- **Flag-flip blockers:** the §T-P bundle rows above are normative — a per-tenant flag does
  not widen past internal canary until its bundle is green **and** its §R drill has been
  executed (14's rehearsal rule). The three gate artifacts are named tests: G09 = TP-1 green;
  G08 = T-S3 green + monitor on; G07 = the Gate-B itest green — each flips its 16
  §Gate-state row with an evidence link, nowhere else.
- **Nightly (never per-PR):** TP-2/TP-3/TP-6 soaks; the S-CH5/S-C8/detector sweeps run in
  staging as jobs, their zero-readings exported as CI-visible dashboards.
- **Irreversible-step blockers:** S-V6 and S-Q8 additionally require their evidence bundles
  (bake metrics, drain telemetry) attached to the PR — a green test suite alone is
  insufficient for the two steps with no undo.

---

## §6 Cross-cutting integrity

### §6.1 Gap traceability (every P0–P2 test gate names its gap)

| Gap (02 §Register) | Closing test gate(s) | Bundle |
|---|---|---|
| G01 (P0) | T-V1, T-V2, T-V3 | §T-P0 |
| G02 (P1) | T-V6 | §T-P0 |
| G03 (P0) | 08 T1/T4/T5 + T-Q5 (survives Redis flush) + T-X1 | §T-P1 |
| G04 (P0) | T-V8 + grep (hazard half); 08 T2 + T-V1 import row (routed half) | §T-P0 / §T-P1 |
| G05 (P1) | 08 T9 + T-Q2 (cancel); 08 T10 + T-X5 (retry) | §T-P1 |
| G06 (P1) | T-Q3, T-Q6, T-Q7 | §T-P1 |
| G07 (P0 ❌) | Gate-B put→signed-get→expiry itest + AC2 | §T-P2 |
| G08 (P0 ❌) | T-S3 + outage drill + no-new-`skipped` monitor | §T-P2 |
| G09 (P0 ❌) | TP-1 (criteria 1–4) — or the fallback's measured floor | §T-P2 |
| G10 (P1) | T-U8 toggle grep (P0 half); 08 T7 (routing half) | §T-P0 / §T-P1 |
| G11 (P1) | T-U6 navigate-away arc + 09 §4.3 poll-never-dies (asserted in T-U2's state copy + T-U8) | §T-P1 |
| G12 (P2) | TP-7 (one constant, two consumers) | §T-P1 |
| G13 (P2) | 08 T6 | §T-P1 |
| G14 (P1) | 08 T8 + T-S1/T-S5 + T-V7/T-S4 | §T-P1 |
| G25 (P2) | R1–R5 rule review on every §M-SEQ DDL row (12 §Success: zero new uniques/inbound FKs on the two intent tables) + the 100M gauge | §T-P2 posture |

(P3/P4 gaps trace inside their bundles: G15/G16 → §T-P3's suite + the G16 guard tests;
G17/G18 → 06's suite; G20 → 04 T1–T6; G21 → T-U7. ◇ gaps carry no gates of their own — 14
owns their deferral dispositions — with one exception: G23's *phased mitigation half* gates
inside §T-P4 via seq 63's tidy-on-merge itest and seq 67's detector invariants.)

### §6.2 The doc-16 update protocol (restated, binding)

A test gate turning green changes nothing by itself. The flow is: **CI evidence link → the 16
row flips (the only place shipped-status lives) → 01's status column → the 02 gap row → 14's
phase gate** — in that order, same week (14 §Success: doc-drift ≤ 1 week). The three infra
gates flip only in 16 §Gate-state tracker. Any divergence found between a doc claim and repo
reality gets a 16 §Drift-log row with a disposition (amend doc vs fix code) — never a silent
edit. This doc's §M-SEQ status is *derivable* (a step is done when its row's test gate is
green and its 16 row says so); §M-SEQ itself is not a status tracker and is never edited to
record progress.

---

## §7 Pre-build answers (delta — the sequencing-level pass; owning docs answer their own)

- **Source of truth.** Step definitions: the owning docs. Order: this doc. Status: doc 16.
  Test IDs: the owning docs (this doc adds only T-X1–T-X6). Numbers (limits, budgets): doc 12's
  constants. No row above re-specifies a design; where two docs disagreed, the ruling is in
  §Reconciliation's mismatch table, cited, not silently picked.
- **Worst case, named: the channel backfill wedges mid-way on a whale workspace.** Detection:
  the batch-progress gauge flatlines + the stall alarm (§2.1). Containment: *zero user-visible
  effect by construction* — reads stay on flat columns until S-CH4, and S-CH4 is gated on the
  completeness query reading 0, so a wedged backfill can only delay the phase, never corrupt
  or half-expose it. Recovery: abort flag → fix → resume from the watermark (or full re-run;
  idempotent). The same argument covers the accounts backfill (§2.2). This is the designed
  property, not luck: every backfill in this program writes dark data behind a read-cutover
  gate.
- **Worst case #2: a step runs out of order** (e.g., S-C4 before S-A5 on a parallel branch).
  Prevention: §M-SEQ preconditions are stated per row; the load-bearing edges are *also*
  code-enforced — S-C4's executor requires the tombstone column and child tables at compile/
  itest time (T1 fails without them), S-I4 cannot compile without a `JobViewer` (S-V2), the
  merge flag cannot be seeded before S-C3 exists. Detection for the rest: the per-PR regen +
  itest suite fails on missing substrate.
- **Worst case #3: migration-number collision across parallel branches.** The
  next-free-number-at-PR-time rule (Reconciliation 1) plus CI's regen check make this a
  mechanical rebase, not a design event — the precedent (0024→0032) is why no doc in this
  series ever cites a number.
- **Failure modes of the rollback levers themselves:** a flag that doesn't actually
  short-circuit is the silent killer — which is why every phase's *byte-identity* test (T-V4,
  08 T1, 05's parity, 06's S-A6 test) is in its bundle and re-run on every PR touching the
  gated path, and why each §R drill executes the flip in staging before any external tenant
  sees the flag.
- **Monitoring.** The §3 fixtures are permanent; each §R section names its post-rollback
  checks; a phase without its runbook + alert entries is not exit-eligible (14's rule,
  enforced here by listing them as CI deliverables on the owning rows: seq 27, 38, 48, 67).

---

## Success metrics (this doc's own)

- Every step ID from 04–13 appears in §M-SEQ exactly once; 07 §8's three hard edges and 14's
  seven conflict resolutions are all encoded as row preconditions (checked at review, and the
  load-bearing ones in code — §7).
- **Zero unrehearsed rollbacks** (14 §Success, owned here): every production flag-off during
  rollout had a previously-executed §R drill; the two irreversible steps (S-V6, S-Q8) shipped
  with their evidence bundles attached.
- Every P0–P2 gap's closing test names it (§6.1) and its 16 row flipped the same week the
  gate went green.
- The drift sweeps read 0 in steady state in production — the dual-write families' permanent
  proof that the migration discipline (expand → dual-write → backfill → verify → cutover)
  held end to end.
