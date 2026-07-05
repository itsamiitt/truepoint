# 16 — Implementation Audit (living document)

> **Purpose:** the single living record of what from this series has actually shipped, in the
> pattern of [`database-management-research/16-Implementation-Audit.md`](../database-management-research/16-Implementation-Audit.md).
> Everything in this series is **design-only** until a row here says otherwise.
>
> **Update protocol:** badge changes flow `16` → `01` (status column) → the gap row in `02` →
> the phase gate in `14`. A doc is never edited to *pretend* something shipped; this file is
> the only place shipped-status lives.

Legend: ✅ shipped & live · 🌒 built, dark (flag-off) · 💤 built, inert/double-gated ·
🟡 partial · 🔲 not built (design only) · ❌ blocked on missing prerequisite.

## Subsystem status

| Area | Design doc | Status | Evidence (file:line / commit) |
|---|---|---|---|
| Job-visibility fix (import/reveal/enrichment lists + RecentImportsCard) | `10` | 🌒 built, dark (S-V1–S-V4; dual gate off/off; CI gates owed before any flip) | commits `71615db` (S-V1 DDL), `8ee6901` (S-V2 predicate/renames), `a69ebe2` (S-V3 wiring + T-V1–T-V4), `97f8a8c` (S-V4 grants/policy + T-V5/T-V6); adversarial review PASS 2026-07-05 |
| Dead-end "Large file" toggle kill + `/imports` scaffold + TanStack seam (S-U1) | `11` | ✅ built (flag-independent; ships with next deploy; lockfile/`next build` CI-owed) | commit `77d2182`; grep gate `largeFile`/`act-bulk-import` extinct |
| Durable sync-import fast path (small files on `import_jobs` trio) | `08` | 🌒 built, dark (S-I3; `IMPORT_V2_ENABLED` dual gate off/off; T1/T4/T5 itests CI-owed) | `packages/core/src/import/runFastImport.ts`, `apps/api/src/features/import/{routes.ts (POST/GET forks), importV2Gate.ts, bulkQueue.ts (enqueueFastImport)}`, worker `register.ts` + `bulkImports.ts` fast kind; `apps/workers/test/importFast.parity.itest.ts` |
| Import history UI (dedicated Imports section — S-U2+) | `11` | 🔲 (S-U1 scaffold only) | — |
| Bulk pipeline enable (COPY path live) | `08`/`14` | 🌒 built, dark — see gate tracker | `apps/api/src/features/import/bulkRoutes.ts`, worker `register.ts` |
| Import error artifacts (repair CSV + error report, typed codes, gated proxied download) | `08`/`10`/`13` | 🌒 built, dark (S-I7/S-S3/S-V5/S-S4; `IMPORT_V2_ENABLED` off; unit T-S1/T-S5 landed, T-V7/T-S4 itests CI-owed) | commits `4ae237f` (S-I7 pair + typed codes + ledger token + write-back), `0e5adf6` (S-S3 neutralizer + `_REDACTED_`), `fb80de8` (S-V5 gate + audit); `packages/core/src/import/artifactWriter.ts`, `packages/types/src/importReject.ts`, `apps/api/src/features/import/artifactRoutes.ts` |
| `contact_emails` / `contact_phones` child tables | `05` | 🔲 | — |
| Contact schema evolutions (merge contract, history) | `04` | 🔲 | — |
| `account_domains` / `account_locations` / `parent_account_id` / accounts soft-delete | `06` | 🔲 | — |
| Outbox-driven import notifications | `09` | 🔲 | — |
| Scheduled / incremental / API imports | `08` §extensions | 🔲 | — |
| Duplicate-review screen | `11` | 🔲 | — |

## Gate-state tracker (bulk-pipeline enable gates + rollout flags)

| Gate / flag | State | Notes |
|---|---|---|
| Production S3-compatible object store (`FileStore` adapter) | ❌ not built | `bulkStore.ts` hardcodes `diskFileStore`; no AWS SDK in repo |
| COPY-FROM-STDIN spike proven | ❌ not run | banner in `importStagingRepository.ts`; zero `sql.copy` usage |
| Real AV/malware scan | ❌ stub | `scanUpload()` permanently returns `"skipped"` |
| `BULK_IMPORT_ENABLED` (env kill-switch) | off (default) | explicit-`"true"`-only |
| `bulk_import_enabled` (per-tenant flag) | seeded off | `global_enabled=false, default=false` |
| `BULK_ENRICHMENT_ENABLED` / `ER_SHADOW_ENABLED` (adjacent, not this series) | off / off | context only — distinct flows |
| `JOB_VISIBILITY_SCOPED` (env kill-switch, S-V3) | off (unset; explicit-`"true"`-only) | flag-off = byte-identical (reviewed) |
| `job_visibility_scoped` (per-tenant flag, seeded in S-V1's migration) | seeded off (`global_enabled=false, default=false`) | cohort flips gated on §T-P0 green in CI |
| `IMPORT_V2_ENABLED` (env kill-switch, S-I3) | off (unset; explicit-`"true"`-only) | flag-off = byte-identical legacy import path (T1 is the proof; §R-P1 lever) |
| `import_v2_enabled` (per-tenant flag, seeded in 0054/S-I1) | seeded off (`global_enabled=false, default=false`) | flips only after §T-P1 green in CI + the §R-P1 rehearsal |

## Drift log

Places where shipped code diverges from this series' design, with disposition
(amend doc vs fix code). Empty at series open.

| Date | Drift | Disposition |
|---|---|---|
| 2026-07-05 | `JobViewer` ships with a required `scoped: boolean` carrying the dual-gate result (doc `10`'s sketch had only `{userId, role}`) — the clean way to honor "required viewer" AND flag-off byte-identity | Amend `10 §4` at next touch; S-V6 deletes the field with the branch |
| 2026-07-05 | The policy-change audit action was never named in `10`/`15` — minted **`import.policy_updated`** (matches `08 §7`'s `import.*` family) | Recorded; `08`/`13` cite the family, no doc edit needed |
| 2026-07-05 | Legacy poll ownership check reads `importedByUserId` off the BullMQ `job.data` payload (doc `10 §5` row said "Redis payload" loosely) | Code shape wins; no doc edit needed |
| 2026-07-05 | `recentBatches` elevated view stays byte-identical (grouped file/source/minute rows have no single creator to attribute) | Per-batch attribution lands with the card split (S-U5, Phase 1) |
| 2026-07-05 | Mapping-template `visibility='private'` list *filtering* deferred with its `08` S-I2 column (S-V4 shipped manage-gates only, per `15` seq-5 wording) | Phase 1 (S-I2) |
| 2026-07-05 | `navConfig` `IMPORTS_DESTINATION` exported but not railed (apps/web has no client-side per-tenant flag reader yet) | Rail entry lands with S-U2; `WIRE(S-U2)` comment marks the seam |
| 2026-07-05 | Enrichment confirm stays `requireRole("owner","admin")` — **stricter** than `10 §5` row 8's creator∪elevated (pre-existing I3 spend-safety posture) | Deliberate; widening deferred, revisit with Phase-1 verbs |
| 2026-07-05 | **Pre-existing, not this program:** types `auditAction` contains `mfa.enroll` but no migration CHECK ever added it — an `mfa.enroll` writer would fail the DB CHECK today | Escalated to the auth/worker-platform track; NOT touched by S-V1's CHECK extension (83 values = current enum minus this drift) |
| 2026-07-05 | **S-I3 transport:** the fast kind rides the unified `bulk-imports` queue with ROWS IN THE PAYLOAD — `09 §1.2`'s "payloads PII-free, always" is deliberately excepted for Phase A (no load-bearing object store until G07; `08 §1.2`/`12 §2.4` are the sanction). Retires at Phase B when the payload slims to `{jobId, scope}` | Documented in `importV2.ts`; no doc edit — 09's rule describes the end state |
| 2026-07-05 | **S-I3 topology:** `08 §1.2`/`09 §1.4` phrase Phase A as "the fast wrapper wraps [the legacy queue's] consumer"; implemented instead per `09 §1.1`'s unified topology (a `fast` kind on `bulk-imports`), which `15 §M-SEQ` seq 12 sequences INSIDE Phase 1 — the legacy `imports` queue/consumer are byte-untouched either way (S-Q8 retires them) | Code shape wins; amend `08 §1.2` wording at next touch |
| 2026-07-05 | **S-I3 ledger:** landed rows (created/matched/duplicate/skipped) get NO per-row `import_job_rows` entries on the fast path — `runImport`'s summary reports them in aggregate only and the engine is mandated UNCHANGED; the rejected-rows ledger IS written per-row. Full landed-row coverage needs an additive engine observer seam | Defer to S-I7 (artifact step); counters carry the truth meanwhile (T4) |
| 2026-07-05 | **S-I3 read model:** gate-on terminal summaries carry counts + histogram with EMPTY `errors`/`rejectedRows` and `addedToList: 0` (the non-PII control row persists neither; legacy Redis summaries carried them inline) | Reject detail arrives with S-I7's artifact pair; `addedToList`'s durable home is an S-I4 DTO decision |
| 2026-07-05 | **S-I3 shed edge:** gate-on, the backpressure 503 can fire AFTER the durable row committed (create → enqueue order is the idempotency-first order) — the row then waits in `queued`, visibly, with no BullMQ job until re-submit (same Idempotency-Key re-submits re-enqueue nothing; a keyless re-submit creates a fresh job) | S-Q5's reaper (Redis-loss re-enqueue from job rows) is the designed healer; acceptable dark |
| 2026-07-05 | **S-I3 side-effects:** fast-path rollups + the `import_complete` notification stay BEST-EFFORT `completed`-handler enqueues, byte-parallel with the legacy handler (`register.ts`) — G06 is NOT closed by S-I3 | By design: S-Q3/S-Q4 move both onto the transactional outbox and retire the two handlers |
| 2026-07-05 | **S-Q1 gating edge:** with the worker now constructed under (BULK_IMPORT ∨ IMPORT_V2), a copy drive/chunk claimed while `BULK_IMPORT_ENABLED` is off FAILS LOUDLY (`CopyKindsDisabledError` → retry → DLQ, operator redrive is idempotent) — under the old both-off construction such jobs would have WAITED for the flag. 09 never specified this sub-case | Deliberate: fail-loud beats silently running a gated pipeline or consuming the job; note for the S-I9 enable runbook |
| 2026-07-05 | **S-Q1 containment:** the dark bulk worker gains the house lock/stall settings (60s/30s/2 → DLQ) + per-kind deadlines via `eventTuning`/`bulkImportKindDeadlineMs`, replacing its bare `concurrency: 1` — a (dark) behavior change sanctioned by 09 Reconciliation #3/#4 | Tripwires extended in `tuning.test.ts` |
| 2026-07-05 | **S-Q2 deferred transport:** `09 §2.2` parks overflow with NO transport (the sweep re-publishes at promotion) — correct for copy (`{jobId, scope}` reconstructable) but a Phase-A fast payload CARRIES THE ROWS, so parking without transport would strand them. Implemented: a deferred fast job also enqueues its payload with a delayed cooperative cap re-check (`IMPORT_DEFER_RECHECK_DELAY_MS`, re-parks at cap with a `:r<n>` id); the leader-locked sweep stays the DB-truth promoter + the copy-drive transport re-publisher, exactly as designed | Phase-A-only mechanics; dies with the rows-in-payload transport at Phase B. `runFastImport`/`register.ts` document it |
| 2026-07-05 | **S-Q2 census:** the per-workspace cap is a SOFT census (no serializing lock — ±1 job under a concurrent-submit race); the atomic fair-share dispatcher is deliberately NOT pre-built (09 §2.1's own rejection of the interim scheduler, worker-platform F7) | By design; `importFairness.ts` header records it |
| 2026-07-05 | **S-Q2 sentinel:** "K=∞ restores enqueue-all" (09 §Rollback) is expressed as `IMPORT_CHUNK_WINDOW=0` (an env int cannot carry ∞); same 0-sentinel for `IMPORT_WORKSPACE_JOB_CAP` (0 = cap disabled) | Recorded; env.ts comments carry the contract |
| 2026-07-05 | **T-Q4 scope:** the S-Q2 itest proves the cap/deferral/promotion MECHANICS (admission, cooperative re-check, oldest-first metered promotion, window helper); the mixed-load contention half of T-Q4 (whale + fast p95 wait) needs the nightly soak rig (12 S-P4 / TP-3) | Split recorded; `importFairness.itest.ts` header cites it |
| 2026-07-05 | **S-Q6 surface:** the shared derivation fn feeds the gate-on poll's `processed` today, but its `percent`/`stage` outputs have NO public field until S-I4's v2 detail DTO (the compatibility-window response keeps the legacy shape byte-for-byte) — 09 §API's "detail response's derived percent/stage" lands then, from this same fn | By design (08 §2.4 window); nothing to amend |
| 2026-07-05 | **S-Q6 cadence vs Phase A:** the copy-side "one delta per ~500-row batch" cadence is a CONTRACT ON THE EXECUTORS pinned as constants — the shipped `bulkProcessChunk` writes its deltas once per CHUNK tx (stricter than the budget, fewer writes) and the fast wrapper once per RUN; neither is loosened. The per-batch write lands when chunk batching itself does | Constants + tests are the tripwire; executors already comply (≤ budget) |
| 2026-07-05 | **S-I7 2nd artifact key:** S-I1 sized ONE `rejected_artifact_key` column (for the single-artifact predecessor); the error-report key rides `import_jobs.options.errorReportKey` (jsonb) rather than an additive column, so the pair ships with no new DDL | Code shape wins; a dedicated column is an optional additive migration if ever wanted |
| 2026-07-05 | **S-I7 vocabulary placement:** the typed reject-code enum is a NEW leaf `packages/types/src/importReject.ts`, NOT importV2.ts as the brief suggested — `rejectedRowSchema` (contacts.ts) references it and importV2.ts imports contacts.ts, so putting it in importV2.ts would cycle; the leaf keeps contacts importing DOWN (the importAdmission.ts leaf precedent) | Code shape wins; no doc edit needed |
| 2026-07-05 | **S-I7 histogram unification deferred:** the ledger `reject_reason` + both artifacts adopt the typed code vocabulary, but the shipped `rejectLabel` / `reject_histogram` KEEP their human-label vocabulary (retyping them ripples into persisted histograms + tests) — 08 §4's "one vocabulary … histogram labels" unification of the histogram is deferred; the code↔label map is 1:1 conceptually | Shipped labels win; align at a later `04`/`08` touch |
| 2026-07-05 | **M6 resolution (S-S4):** 08 §6.2's "signed expiring URLs" is superseded by 13 §4.3's PROXIED-WITH-AUDIT streaming — S-S4 ships proxied delivery (getObjectStream → pinned `text/csv`/nosniff/attachment/no-store headers); presigned URLs are NOT built (documented bounded fallback: TTL ≤ 5 min, audit-at-mint, never in a notification). Resolves 15 §Mismatches ruling M6 | Recorded as M6 required; amend 08 §6.2 / 10 §5 row 5 wording at next touch |
| 2026-07-05 | **S-V5 stricter download bucket:** 10 §7 / 13 §7 mandate a stricter per-user download bucket, but the shipped `rateLimit` middleware exposes no per-route bucket knob — the coarse limiter is applied; the dedicated bucket is config-owed | Deferred; note for the abuse-control follow-up (no knob today) |
