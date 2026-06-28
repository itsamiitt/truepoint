// importStagingRepository.ts — ALL data access for the per-job UNLOGGED, NON-RLS staging table that the bulk
// COPY-staging import pipeline fast-loads (15-bulk-import-design §1/§2/§8, backlog #2). EVERYTHING here runs on
// the OWNER connection (`ownerClient`) — NOT `withTenantTx`/leadwolf_app — because Postgres forbids COPY on an
// RLS table, so the staging table is deliberately non-RLS. The cost of that choice is that isolation drops to
// ACCESS PATH: every read carries an EXPLICIT `workspace_id` predicate (a forgotten predicate would leak across
// workspaces), and all staging access is CONFINED to this one repository. The table holds the ALREADY-PREPARED
// row (ciphertext + blind index + content_hash) so PII is encrypted even in staging; `raw_data` is the only
// plaintext (transient, dropped on finalize). The table is created/dropped at RUNTIME per job (not in a migration).
//
// ╔═══════════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ UNVERIFIED — the COPY-FROM-STDIN streaming path (`copyRows`) is the one load-bearing primitive that CANNOT  ║
// ║ be exercised in this sandbox (no bun, no Postgres). `postgres.js` has ZERO prior `COPY`/`.writable()` usage ║
// ║ in this repo. Before `BULK_IMPORT_ENABLED` is turned on, the §6.4 COPY spike MUST prove, on a real         ║
// ║ Postgres over the owner connection: (1) `ownerClient.unsafe(<COPY … FROM STDIN>).writable()` returns a     ║
// ║ backpressure-aware Node Writable; (2) the CSV encoding below (bytea as unquoted `\x<hex>`; NULL as the      ║
// ║ unquoted empty field; jsonb/text quoted) round-trips byte-for-byte; (3) bytea columns read back as Buffer. ║
// ╚═══════════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// ENCODING CHOICE (documented): the staging bytea columns are declared `bytea` and written via COPY in CSV
// format as unquoted `\x<hex>` text — in CSV mode Postgres treats backslash as a LITERAL (unlike the default
// text format, where it is an escape), so `\xDEADBEEF` reaches the bytea input function verbatim and is parsed
// as hex. NULL is the default CSV NULL: an UNQUOTED empty field. Every non-null text/json cell is QUOTED (and
// internal quotes doubled), so a non-null value can never be misread as NULL. On read, `postgres.js` decodes
// `bytea` → Buffer and `jsonb` → object automatically, so no manual hex decode is needed.

import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ownerClient } from "../client.ts";

/**
 * One staged import row — the prepared, encrypted contact plus the dedup keys and the raw source row. The SAME
 * shape is written (by `bulkStage` via `copyRows`) and read back (by `bulkProcessChunk` via `readChunkBand`).
 * `email*`/`phone_enc` are null when the source row carried no email/phone (the absence is meaningful — the
 * merge restores it as "field omitted", never as an explicit null overwrite). `contentHash` and `rawData` are
 * always present. `identityKey` follows the findByDedupKeys precedence (email → linkedin → sales-nav).
 */
export interface StagingRow {
  sourceRowNum: number;
  workspaceId: string;
  identityKey: string | null;
  emailEnc: Uint8Array | null;
  phoneEnc: Uint8Array | null;
  emailBlindIndex: Uint8Array | null;
  contentHash: Uint8Array;
  emailDomain: string | null;
  linkedinPublicId: string | null;
  salesNavLeadId: string | null;
  firstName: string | null;
  lastName: string | null;
  jobTitle: string | null;
  seniorityLevel: string | null;
  department: string | null;
  linkedinUrl: string | null;
  salesNavProfileUrl: string | null;
  locationCountry: string | null;
  locationCity: string | null;
  accountName: string | null;
  accountDomain: string | null;
  rawData: Record<string, unknown>;
}

// The staging columns COPY loads, in order. `row_status` is omitted (it takes its DEFAULT 'pending').
const STAGING_COPY_COLUMNS = [
  "source_row_num",
  "workspace_id",
  "identity_key",
  "email_enc",
  "phone_enc",
  "email_blind_index",
  "content_hash",
  "email_domain",
  "linkedin_public_id",
  "sales_nav_lead_id",
  "first_name",
  "last_name",
  "job_title",
  "seniority_level",
  "department",
  "linkedin_url",
  "sales_nav_profile_url",
  "location_country",
  "location_city",
  "account_name",
  "account_domain",
  "raw_data",
] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Derive the per-job staging table name `stg_import_<jobId, dashes→underscores>`. The jobId is VALIDATED as a
 * uuid first and lowercased — so the only characters that ever reach the interpolated DDL/COPY/SELECT text are
 * `[0-9a-f_]`. This is the ONE place untrusted-looking text touches a non-parameterizable identifier; a
 * non-uuid id is refused rather than interpolated. Result length (~47 chars) is well under Postgres' 63-char
 * identifier limit and the schema's `staging_table varchar(128)`.
 */
function stagingTableName(jobId: string): string {
  if (!UUID_RE.test(jobId)) {
    throw new Error(`importStagingRepository: refusing a non-uuid job id for a staging table: ${jobId}`);
  }
  return `stg_import_${jobId.toLowerCase().replace(/-/g, "_")}`;
}

/** CSV-encode one cell for COPY … WITH (FORMAT csv): null → NULL (unquoted empty); number → bare digits;
 *  bytea → unquoted `\x<hex>` (backslash is literal in CSV); string/json → quoted with internal quotes doubled. */
function csvField(value: number | string | Uint8Array | null): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  if (value instanceof Uint8Array) return `\\x${Buffer.from(value).toString("hex")}`;
  return `"${value.replace(/"/g, '""')}"`;
}

/** Stream each staged row as one CSV line (constant memory — one row buffered at a time; backpressure is the
 *  pipeline's job). Column order MUST match STAGING_COPY_COLUMNS. */
async function* encodeRows(rows: AsyncIterable<StagingRow>): AsyncIterable<Buffer> {
  for await (const r of rows) {
    const cells: Array<number | string | Uint8Array | null> = [
      r.sourceRowNum,
      r.workspaceId,
      r.identityKey,
      r.emailEnc,
      r.phoneEnc,
      r.emailBlindIndex,
      r.contentHash,
      r.emailDomain,
      r.linkedinPublicId,
      r.salesNavLeadId,
      r.firstName,
      r.lastName,
      r.jobTitle,
      r.seniorityLevel,
      r.department,
      r.linkedinUrl,
      r.salesNavProfileUrl,
      r.locationCountry,
      r.locationCity,
      r.accountName,
      r.accountDomain,
      JSON.stringify(r.rawData),
    ];
    yield Buffer.from(`${cells.map(csvField).join(",")}\n`, "utf8");
  }
}

/** postgres.js decodes `bytea` → Buffer (a Uint8Array); pass it through, mapping NULL → null. */
function toBytea(value: unknown): Uint8Array | null {
  if (value === null || value === undefined) return null;
  return value as Uint8Array;
}

function mapStagedRow(r: Record<string, unknown>): StagingRow {
  return {
    sourceRowNum: Number(r.source_row_num),
    workspaceId: r.workspace_id as string,
    identityKey: (r.identity_key as string | null) ?? null,
    emailEnc: toBytea(r.email_enc),
    phoneEnc: toBytea(r.phone_enc),
    emailBlindIndex: toBytea(r.email_blind_index),
    contentHash: toBytea(r.content_hash) ?? new Uint8Array(0),
    emailDomain: (r.email_domain as string | null) ?? null,
    linkedinPublicId: (r.linkedin_public_id as string | null) ?? null,
    salesNavLeadId: (r.sales_nav_lead_id as string | null) ?? null,
    firstName: (r.first_name as string | null) ?? null,
    lastName: (r.last_name as string | null) ?? null,
    jobTitle: (r.job_title as string | null) ?? null,
    seniorityLevel: (r.seniority_level as string | null) ?? null,
    department: (r.department as string | null) ?? null,
    linkedinUrl: (r.linkedin_url as string | null) ?? null,
    salesNavProfileUrl: (r.sales_nav_profile_url as string | null) ?? null,
    locationCountry: (r.location_country as string | null) ?? null,
    locationCity: (r.location_city as string | null) ?? null,
    accountName: (r.account_name as string | null) ?? null,
    accountDomain: (r.account_domain as string | null) ?? null,
    rawData: (r.raw_data as Record<string, unknown> | null) ?? {},
  };
}

export const importStagingRepository = {
  /** The per-job staging table name (validated, uuid-derived). Exposed so the drive phase can stamp it onto the
   *  job row (`import_jobs.staging_table`) — but the name is fully derivable from the jobId, never trusted text. */
  stagingTableName,

  /**
   * Create the per-job UNLOGGED, NON-RLS staging table (+ its source_row_num / identity_key indexes), idempotent
   * via IF NOT EXISTS. UNLOGGED = no WAL (fast load, lost on crash — acceptable; the file in the FileStore is the
   * source of truth and the stage is re-runnable). Runs on the owner connection. `workspaceId` is reserved for
   * symmetry/forward-use — the table is per-job and each row carries its own `workspace_id` (populated by COPY).
   */
  async createStagingTable(jobId: string, _workspaceId: string): Promise<void> {
    const name = stagingTableName(jobId);
    await ownerClient.unsafe(
      `CREATE UNLOGGED TABLE IF NOT EXISTS ${name} (
        source_row_num integer NOT NULL,
        workspace_id uuid NOT NULL,
        identity_key text,
        email_enc bytea,
        phone_enc bytea,
        email_blind_index bytea,
        content_hash bytea NOT NULL,
        email_domain text,
        linkedin_public_id text,
        sales_nav_lead_id text,
        first_name text,
        last_name text,
        job_title text,
        seniority_level text,
        department text,
        linkedin_url text,
        sales_nav_profile_url text,
        location_country text,
        location_city text,
        account_name text,
        account_domain text,
        raw_data jsonb NOT NULL,
        row_status text NOT NULL DEFAULT 'pending'
      )`,
    );
    await ownerClient.unsafe(
      `CREATE INDEX IF NOT EXISTS ${name}_sr_idx ON ${name} (source_row_num)`,
    );
    await ownerClient.unsafe(
      `CREATE INDEX IF NOT EXISTS ${name}_ik_idx ON ${name} (identity_key)`,
    );
  },

  /**
   * Fast-load the prepared rows via COPY … FROM STDIN (CSV) on the owner connection. The rows stream through a
   * backpressure-aware Node Writable (constant memory — never buffers the whole file). See the file header for
   * the encoding + the UNVERIFIED warning. Never throws raw: any failure is wrapped with the jobId for context.
   */
  async copyRows(jobId: string, rows: AsyncIterable<StagingRow>): Promise<void> {
    const name = stagingTableName(jobId);
    const copySql = `COPY ${name} (${STAGING_COPY_COLUMNS.join(", ")}) FROM STDIN WITH (FORMAT csv)`;
    try {
      // UNVERIFIED: postgres.js COPY streaming. `.writable()` resolves to a Node Writable; `pipeline` feeds the
      // encoded CSV lines into it with backpressure and finalizes the COPY on end (or rejects on error).
      const writable = await ownerClient.unsafe(copySql).writable();
      await pipeline(Readable.from(encodeRows(rows)), writable);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`importStagingRepository.copyRows failed for job ${jobId}: ${reason}`);
    }
  },

  /**
   * Within-file dedup: mark every NON-survivor `row_status='dedup_in_file'`, keeping the survivor of
   * `DISTINCT ON (identity_key) … ORDER BY identity_key, source_row_num` (the LOWEST source_row_num wins — the
   * same email→linkedin→sales-nav precedence findByDedupKeys uses, baked into `identity_key`). Rows with a NULL
   * identity_key are never collapsed (they all survive). Returns the number of rows marked. Idempotent on re-run.
   */
  async dedupWithinFile(jobId: string): Promise<number> {
    const name = stagingTableName(jobId);
    const res = await ownerClient.unsafe(
      `UPDATE ${name} SET row_status = 'dedup_in_file'
        WHERE identity_key IS NOT NULL
          AND source_row_num NOT IN (
            SELECT DISTINCT ON (identity_key) source_row_num
              FROM ${name}
             WHERE identity_key IS NOT NULL
             ORDER BY identity_key, source_row_num
          )`,
    );
    return (res as unknown as { count?: number }).count ?? 0;
  },

  /**
   * Read the PENDING survivors of one chunk band `[rowStart, rowEnd)`. The EXPLICIT `workspace_id` predicate is
   * the access-path isolation that replaces RLS on this non-RLS table (15 §8) — never drop it. Decodes bytea →
   * Buffer and jsonb → object via postgres.js's built-in parsers. Ordered by source_row_num.
   */
  async readChunkBand(
    jobId: string,
    workspaceId: string,
    rowStart: number,
    rowEnd: number,
  ): Promise<StagingRow[]> {
    const name = stagingTableName(jobId);
    const rows = await ownerClient.unsafe(
      `SELECT source_row_num, workspace_id, identity_key, email_enc, phone_enc, email_blind_index,
              content_hash, email_domain, linkedin_public_id, sales_nav_lead_id, first_name, last_name,
              job_title, seniority_level, department, linkedin_url, sales_nav_profile_url,
              location_country, location_city, account_name, account_domain, raw_data
         FROM ${name}
        WHERE workspace_id = $1 AND row_status = 'pending'
          AND source_row_num >= $2 AND source_row_num < $3
        ORDER BY source_row_num`,
      [workspaceId, rowStart, rowEnd],
    );
    return (rows as unknown as Array<Record<string, unknown>>).map(mapStagedRow);
  },

  /** Total rows currently in the staging table (chunk planning / diagnostics). Owner connection. */
  async countStaged(jobId: string): Promise<number> {
    const name = stagingTableName(jobId);
    const rows = await ownerClient.unsafe(`SELECT count(*)::int AS n FROM ${name}`);
    const first = (rows as unknown as Array<{ n: number }>)[0];
    return Number(first?.n ?? 0);
  },

  /** Drop the per-job staging table (finalize cleanup). Idempotent via IF EXISTS; owner connection. */
  async dropStagingTable(jobId: string): Promise<void> {
    const name = stagingTableName(jobId);
    await ownerClient.unsafe(`DROP TABLE IF EXISTS ${name}`);
  },
};
