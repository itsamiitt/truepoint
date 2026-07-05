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
| Durable sync-import fast path (small files on `import_jobs` trio) | `08` | 🔲 | — |
| Import history UI (dedicated Imports section — S-U2+) | `11` | 🔲 (S-U1 scaffold only) | — |
| Bulk pipeline enable (COPY path live) | `08`/`14` | 🌒 built, dark — see gate tracker | `apps/api/src/features/import/bulkRoutes.ts`, worker `register.ts` |
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
