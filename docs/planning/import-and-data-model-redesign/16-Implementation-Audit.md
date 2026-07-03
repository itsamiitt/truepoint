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
| Job-visibility fix (import/reveal/enrichment lists + RecentImportsCard) | `10` | 🔲 | — |
| Durable sync-import fast path (small files on `import_jobs` trio) | `08` | 🔲 | — |
| Import history UI (dedicated Imports section) | `11` | 🔲 | — |
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

## Drift log

Places where shipped code diverges from this series' design, with disposition
(amend doc vs fix code). Empty at series open.

| Date | Drift | Disposition |
|---|---|---|
| — | — | — |
