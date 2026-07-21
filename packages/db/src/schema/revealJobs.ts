// revealJobs.ts — Drizzle schema for the ASYNC bulk-reveal job (reveal-experience Phase 3, ADR-0029/0036).
// The control table `reveal_jobs` (one per submitted selection) + the per-contact ledger `reveal_job_rows`
// (the work-list AND the outcome record; a row starts `queued` and a chunk drives it to a terminal outcome —
// so resume/retry-failed is just "which rows aren't terminal"). Workspace-scoped like contacts/enrichment_jobs;
// closed enums use the varchar + CHECK idiom (this repo declares no pgEnum). Credits are whole numbers here
// (the tenant reveal-credit counter is integer credits, unlike enrichment's provider micro-dollars).

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { tenants, users, workspaces } from "./auth.ts";
import { contacts } from "./contacts.ts";

const id = () => uuid("id").primaryKey().default(sql`uuid_generate_v7()`);
const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id, { onDelete: "cascade" });
const workspaceId = () =>
  uuid("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "cascade" });

// ── reveal_jobs — the control row (one per submitted bulk-reveal) ───────────────────────────────────────
export const revealJobs = pgTable(
  "reveal_jobs",
  {
    id: id(),
    tenantId: tenantId(),
    workspaceId: workspaceId(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id), // null = system
    revealType: varchar("reveal_type", { length: 20 }).notNull(), // email | phone | full_profile
    status: varchar("status", { length: 30 }).notNull().default("queued"),
    totalContacts: integer("total_contacts").notNull().default(0),
    processedContacts: integer("processed_contacts").notNull().default(0),
    revealedContacts: integer("revealed_contacts").notNull().default(0),
    alreadyOwnedContacts: integer("already_owned_contacts").notNull().default(0),
    suppressedContacts: integer("suppressed_contacts").notNull().default(0),
    failedContacts: integer("failed_contacts").notNull().default(0),
    // Credit accounting (whole credits). estimate = the worst-case ceiling shown at confirm; leased = the
    // amount reserved off the tenant counter at confirm; spent = the actual charged (≤ leased). The unused
    // (leased − spent) is RELEASED at finalize (ADR-0029 reserve-then-settle).
    creditEstimate: integer("credit_estimate").notNull().default(0),
    creditLeased: integer("credit_leased").notNull().default(0),
    // How much of the lease came off the perishable subscription bucket — so release restores the right split.
    creditLeasedFromSub: integer("credit_leased_from_sub").notNull().default(0),
    creditSpent: integer("credit_spent").notNull().default(0),
    resultKey: varchar("result_key", { length: 1024 }), // S3 key of the revealed CSV once written (nullable)
    // Per-job share flag (import-redesign 10 §2.3, S-V1): column now, UX deferred — written by no route,
    // read only by the jobVisibility predicate (constant false ⇒ zero behavior change while unset).
    sharedWithWorkspace: boolean("shared_with_workspace").notNull().default(false),
    idempotencyKey: varchar("idempotency_key", { length: 255 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    failedReason: varchar("failed_reason", { length: 1024 }),
  },
  (t) => ({
    byWsStatus: index("idx_reveal_jobs_ws_status").on(t.workspaceId, t.status),
    // Member-path keyset list (import-redesign 10 S-V1): the jobVisibility predicate narrowed to a creator
    // within a workspace, newest-first — keeps the scoped list index-ordered (no sort node).
    byWsCreatorCreated: index("idx_reveal_jobs_ws_creator_created").on(
      t.workspaceId,
      t.createdByUserId,
      t.createdAt.desc(),
      t.id.desc(),
    ),
    uniqWsIdempotency: uniqueIndex("uniq_reveal_jobs_ws_idempotency")
      .on(t.workspaceId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    statusEnum: check(
      "reveal_jobs_status_enum",
      sql`${t.status} IN ('queued','estimating','awaiting_confirmation','running','paused','completed','failed','cancelled')`,
    ),
    revealTypeEnum: check(
      "reveal_jobs_reveal_type_enum",
      sql`${t.revealType} IN ('email','phone','full_profile')`,
    ),
  }),
);

// ── reveal_job_rows — one row per selected contact: the work-list AND the outcome/cost record ────────────
export const revealJobRows = pgTable(
  "reveal_job_rows",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => revealJobs.id, { onDelete: "cascade" }),
    workspaceId: workspaceId(), // denormalized for direct RLS on this per-contact table
    contactId: uuid("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    rowIndex: integer("row_index").notNull(), // 0-based position in the submitted selection (the chunk band key)
    outcome: varchar("outcome", { length: 20 }).notNull().default("queued"),
    creditsCharged: integer("credits_charged").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Idempotent per-contact processing: a redelivered chunk INSERT-conflicts on (job, contact) → skips it.
    uniqJobContact: uniqueIndex("uniq_reveal_job_rows_job_contact").on(t.jobId, t.contactId),
    byJobRowIndex: index("idx_reveal_job_rows_job_row").on(t.jobId, t.rowIndex),
    byWsOutcome: index("idx_reveal_job_rows_ws_outcome").on(t.workspaceId, t.outcome),
    outcomeEnum: check(
      "reveal_job_rows_outcome_enum",
      sql`${t.outcome} IN ('queued','revealed','already_owned','suppressed','insufficient','error')`,
    ),
  }),
);
