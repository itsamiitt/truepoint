// importLimits.ts — THE published product limits (import-and-data-model-redesign 12 §5, step S-P2). ONE
// source of truth for the launch ceilings, consumed by BOTH the API admission/routing path (@leadwolf/core
// admission.ts + apps/api's import routes) AND the web upload UI (apps/web renders the ceilings BEFORE
// selection, 12 §5) — the TP-7 "one-constant-two-consumers" invariant: nobody re-types a magic number.
// Numbers are 12 §5's launch values; the "after 2M soak (S-P4)" raises are a config change HERE, not code
// spread across the tree. Every rejecting RFC-9457 problem carries the relevant limit as an extension member
// (FileTooLargeError.maxBytes / ImportTooLargeError.{limit,current}), so a refusal always names its ceiling.

const MiB = 1024 * 1024;

/** Max rows per CSV file (12 §5 launch: 1,000,000; anchored to HubSpot's 1,048,576). Soak raise: 2,000,000. */
export const IMPORT_MAX_CSV_ROWS = 1_000_000;

/** Max CSV file bytes (12 §5 launch: 250 MB; between Salesforce 150 MB and HubSpot 512 MB). Soak raise: 500 MB. */
export const IMPORT_MAX_CSV_BYTES = 250 * MiB;

/**
 * Max XLSX workbook bytes. SHIPPED-CODE-WINS DRIFT (16 drift log): 12 §5 publishes **10 MB** for the
 * fast-path XLSX pair, but the shipped `parseXlsx` / S-S1 admission ceiling is **25 MiB** and stays
 * authoritative — lowering it here would tighten a live admission gate. The 10 MB figure is the fast-path
 * *routing* target (IMPORT_FASTPATH_MAX_BYTES), re-measured with the soak; this constant is the hard
 * admission cap. Reconcile the two numbers when S-P4's soak lands (14 §5 ceiling raise).
 */
export const IMPORT_MAX_XLSX_BYTES = 25 * MiB;

/** Max XLSX data rows (excludes the header) — shipped `parseXlsx` cap. */
export const IMPORT_MAX_XLSX_ROWS = 100_000;

/** Max XLSX header columns — shipped `parseXlsx` cap. */
export const IMPORT_MAX_XLSX_COLS = 256;

/**
 * Fast-path routing BYTE ceiling (12 §5 fast pair: ≤ 10 MB alongside ≤ `BULK_IMPORT_THRESHOLD_ROWS` rows).
 * Above this OR the row threshold the server would route to `copy` mode; until the copy enable-gates clear
 * (G07+G09), that is an honest `file_too_large` refusal instead (08 §1 — never a dead-end toggle). The row
 * half is `env.BULK_IMPORT_THRESHOLD_ROWS` (default 5000; a per-env knob, so it lives in config, not here).
 */
export const IMPORT_FASTPATH_MAX_BYTES = 10 * MiB;

/** Concurrent running imports per workspace before new commits park `deferred` (12 §5; the visible-
 *  backpressure state). Mirrors `env.IMPORT_WORKSPACE_JOB_CAP`'s default — the knob is env-tunable there. */
export const IMPORT_MAX_CONCURRENT_PER_WORKSPACE = 3;

/** Commits per workspace per hour (12 §5 / 08 §2.3) → 429 `import_quota_exceeded` (writer lands S-I10). */
export const IMPORT_MAX_COMMITS_PER_HOUR = 20;

/** Rows per workspace per day (12 §5). */
export const IMPORT_MAX_ROWS_PER_DAY = 5_000_000;

/** Saved mapping templates per workspace (12 §5 — ops hygiene on a leapfrog surface). */
export const IMPORT_MAX_TEMPLATES_PER_WORKSPACE = 50;
