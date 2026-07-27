// client.ts — the postgres.js connection + Drizzle instance, and withTenantTx: the ONLY way a repository
// opens a tenant/workspace-scoped transaction. It sets the RLS GUCs LOCAL to the transaction (RDS Proxy
// transaction pooling resets them per checkout, so they must be set in-tx). 03 §9, architecture-contract §6.

import { env } from "@leadwolf/config";
import type { PlatformAuditAction } from "@leadwolf/types";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

// `prepare: false` is required for transaction-pooling proxies (RDS Proxy / PgBouncer).
//
// Pool size and statement timeout come from config rather than being baked in (E-6.3). The size was hardcoded
// at 10, which is a DEPLOY-shaped decision living in source: the right number depends on the host's connection
// budget and how many replicas share it, and neither is knowable from here. Defaults preserve today's exact
// behaviour — 10 connections, no statement timeout.
//
// `statement_timeout` is passed only when set, because 0 means "no limit" to Postgres and sending it
// explicitly would be indistinguishable from the current default while looking deliberate. Why it is OFF by
// default is a real constraint, not caution: apps/api and apps/workers share THIS pool with very different
// statement profiles — a request-path query running 30s is pathological, while the daily data-quality sweep's
// jsonb scans over a large tenant can legitimately run for minutes. One value cannot bound the first without
// killing the second; that needs the per-surface pool split E-6.3/E-6.6 describe.
const poolOptions: Parameters<typeof postgres>[1] = { max: env.DB_POOL_MAX, prepare: false };
if (env.DB_STATEMENT_TIMEOUT_MS > 0) {
  poolOptions.connection = { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS };
}
const client = postgres(env.DATABASE_URL, poolOptions);

/**
 * The Forge data plane's OWN pool (E-6.6).
 *
 * `withForgeTx` used to run on the pool above — the customer request path's. The Forge DAG holds transactions
 * across provider network I/O (extraction calls Anthropic mid-transaction), so a backlog there could occupy
 * every one of those connections and starve customer requests. There was no capacity isolation and no failure
 * isolation between a background pipeline and the thing users are waiting on.
 *
 * A separate pool fixes the capacity half even when both point at the SAME database, which is the default
 * (`FORGE_DATABASE_URL` unset). Pointing it at a different database or a replica later adds failure isolation
 * with no further code change.
 *
 * This does not double connection usage in practice: postgres.js connects LAZILY, so an api process that
 * never calls `withForgeTx` opens zero Forge connections. The budget is also deliberately smaller — Forge is
 * throughput work behind a queue and can wait; a customer request cannot.
 */
const forgePoolOptions: Parameters<typeof postgres>[1] = {
  max: env.FORGE_DB_POOL_MAX,
  prepare: false,
};
if (env.DB_STATEMENT_TIMEOUT_MS > 0) {
  forgePoolOptions.connection = { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS };
}
const forgeClient = postgres(env.FORGE_DATABASE_URL ?? env.DATABASE_URL, forgePoolOptions);

/**
 * The TENANT-TRAFFIC pool, logged in AS `leadwolf_app` (E-6.3).
 *
 * `applyMigrations` creates that role `LOGIN` and its header has always said "the app connects AS
 * leadwolf_app (RLS-enforced)" — but the runtime pool never did. It logs in as the DB OWNER, which is
 * BYPASSRLS, and `withTenantTx` compensates by dropping to `leadwolf_app` per transaction.
 *
 * That compensation is one statement away from failing open. If the role assignment is ever skipped, reordered
 * or silently errors, the queries inside still run — as the owner, with RLS bypassed and no tenant predicate.
 * Connecting as the non-BYPASSRLS role instead makes the isolation a property of the CONNECTION rather than of
 * a statement that has to succeed every time: an unscoped read fails closed (the RLS policies use the
 * NULLIF idiom, so an unset GUC matches nothing) instead of returning another tenant's rows.
 *
 * Derived rather than configured separately: same host/database as DATABASE_URL, with the username and
 * password swapped to the app role. Falls back to the owner connection when no app-role password is available,
 * which is exactly today's behaviour — so this hardens a deployment that sets the password and changes nothing
 * for one that does not.
 *
 * `withPrivilegedTx` / `withErTx` / `withForgeTx` deliberately do NOT use this pool: they `SET LOCAL ROLE` to
 * roles `leadwolf_app` is not a member of (by design), so they must keep the owner connection.
 */
function appConnectionUrl(): string {
  if (!env.DATABASE_APP_ROLE_PASSWORD) return env.DATABASE_URL;
  try {
    const url = new URL(env.DATABASE_URL);
    url.username = env.DATABASE_APP_ROLE;
    url.password = env.DATABASE_APP_ROLE_PASSWORD;
    return url.toString();
  } catch {
    // An unparseable DATABASE_URL is not this function's problem to report — postgres() will fail with a far
    // better message on the owner connection above. Fall back rather than masking it.
    return env.DATABASE_URL;
  }
}

const appPoolOptions: Parameters<typeof postgres>[1] = { max: env.DB_POOL_MAX, prepare: false };
if (env.DB_STATEMENT_TIMEOUT_MS > 0) {
  appPoolOptions.connection = { statement_timeout: env.DB_STATEMENT_TIMEOUT_MS };
}
const appClient = postgres(appConnectionUrl(), appPoolOptions);

export const db = drizzle(client, { schema });
/** Drizzle bound to the tenant pool (leadwolf_app when configured). Used ONLY by withTenantTx. */
const appDb = drizzle(appClient, { schema });
/** Drizzle bound to the Forge pool. Same schema; only the connection budget differs. */
const forgeDb = drizzle(forgeClient, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The raw OWNER (RLS-BYPASSING) postgres.js connection — the SAME base connection `db` wraps (so it inherits
 * `prepare: false`, RDS-Proxy/PgBouncer-safe). Exported ONLY for `importStagingRepository`, which drives the
 * per-job UNLOGGED, NON-RLS staging table: Postgres forbids COPY on an RLS table (15-bulk-import-design §1),
 * so the COPY fast-load + the staging DDL/dedup/read run on this owner connection. NEVER use it for
 * tenant-scoped data — that MUST go through `withTenantTx` (drops to leadwolf_app, RLS enforced). The only
 * isolation on staging is the explicit `workspace_id` predicate every staging query carries (access path).
 */
export { client as ownerClient };

/** Drain the shared pool — graceful shutdown for apps/workers and test teardown (open sockets otherwise
 * keep the process alive). Safe to call once at the end of a process's life; not for per-request use. */
export async function closeDb(): Promise<void> {
  // Both pools: the Forge one is lazy, so in a process that never touched it this is a no-op — but leaving it
  // open would keep the process alive in exactly the tests and workers this function exists to let exit.
  await Promise.all([
    client.end({ timeout: 5 }),
    appClient.end({ timeout: 5 }),
    forgeClient.end({ timeout: 5 }),
  ]);
}

/** Connectivity check for readiness probes: the cheapest statement that still proves the whole path — a free
 * pool slot, a live socket, and a server that answers. Rejects (never hangs on its own) if any of those fail;
 * bounding the wait is the caller's job, since only the caller knows its probe budget.
 *
 * Deliberately UNSCOPED — no tenant GUCs, no session role. This asks "is the database reachable", not "may
 * this caller read anything", so requiring a scope would make it untestable at boot and wrong at every other
 * time. It lives here rather than in a consuming app so raw SQL stays inside @leadwolf/db. */
export async function pingDb(): Promise<void> {
  await db.execute(sql`SELECT 1`);
}

/**
 * Run `fn` under the PRIVILEGED leadwolf_admin role (BYPASSRLS — 03 §9, ADR-0011): the ONE sanctioned
 * cross-workspace path, used only by the audited DSAR fan-out (08 §4) and, later, apps/admin. The role is
 * transaction-local; every caller is responsible for writing its audit trail.
 */
export async function withPrivilegedTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE leadwolf_admin`);
    return fn(tx);
  });
}

/**
 * Run `fn` under the least-privilege Layer-0 resolution role `leadwolf_er` (ADR-0021 MATCH-AGAINST;
 * prospect-company-data PLAN_01 §4) — the deterministic-resolution path that READS the master graph and
 * performs co-op-safe MINTS (masterGraphRepository.resolveForImport). The role is NON-BYPASSRLS and has NO
 * overlay grant: it can only reach the system-owned Layer-0 tables (master_*, source_records, match_links),
 * never a tenant-scoped one. There are NO GUCs to set — the master tables carry no workspace_id and are not
 * RLS-scoped (isolation is structural, by access path; PLAN_01 §5). `SET LOCAL ROLE` is transaction-local
 * (RDS-Proxy/PgBouncer-safe), exactly like withTenantTx/withPrivilegedTx.
 */
export async function withErTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE leadwolf_er`);
    return fn(tx);
  });
}

/**
 * Run `fn` under the least-privilege `leadwolf_forge` role — the TruePoint Forge data-plane path (ADR-0047).
 * NON-BYPASSRLS, owns ONLY the `forge` schema (raw_captures → parsed_records → verified_records + ER/governance);
 * it has NO grant on the tenant overlay, so the ingest→verify pipeline can never read a customer's contacts.
 * There are no GUCs to set, but NOT for the reason this comment used to give. It claimed "the forge tables
 * carry no workspace_id", which is factually wrong: `forge.raw_captures.target_tenant_id` is NOT NULL and
 * `target_workspace_id` exists (schema/forge.ts). Reads here are genuinely UNSCOPED — nothing filters by
 * tenant — so the isolation is entirely SCHEMA + ROLE, not row-level: `leadwolf_forge` owns the `forge`
 * schema and holds no grant on the public/overlay tables, and `leadwolf_app` has no USAGE on `forge`.
 * That wall is real and is pinned by forgeSchemaIsolation.itest.ts, but it is a wall between the FORGE plane
 * and the TENANT plane — it is not, and must not be mistaken for, isolation BETWEEN tenants inside forge.
 * Forge is a shared, staff-operated data plane by design; every cross-tenant read through it is audited
 * instead (ADR-0032, the /bff/* readers). Anything that ever needs per-tenant scoping inside forge has to add
 * it explicitly — the columns are there, the enforcement is not.
 * `SET LOCAL ROLE` is transaction-local (RDS-Proxy/PgBouncer-safe). Promotion into master_* still uses withErTx.
 */
export async function withForgeTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  // Runs on the FORGE pool, not the customer request pool (E-6.6) — see forgeDb above for why.
  return forgeDb.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE leadwolf_forge`);
    return fn(tx);
  });
}

export interface TenantScope {
  tenantId: string;
  workspaceId?: string;
}

/**
 * Run `fn` inside a transaction with the RLS role + GUCs set LOCAL — the only sanctioned scoped-query path.
 * Dropping to the **non-BYPASSRLS** app role for the scope of the tx is what makes RLS actually enforced even
 * when the base connection is privileged (the documented dev/superuser case — and the case in this deployment,
 * where the pool logs in as the owner). Role and GUCs are transaction-local (RDS-Proxy-safe), and are applied
 * in a single round-trip. 03 §9, architecture-contract §6.
 */
export async function withTenantTx<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  // The TENANT pool (leadwolf_app when configured) — see appDb. The set_config below still runs: it is what
  // pins the tenant/workspace GUCs, and setting `role` to the role we are already logged in as is a no-op
  // that keeps behaviour identical when the app URL falls back to the owner connection.
  return appDb.transaction(async (tx) => {
    // RLS setup in ONE round-trip (perf root cause #7 — this is the per-read latency floor under every
    // authenticated endpoint, and the DB is remote, so each avoided round-trip is real milliseconds × every
    // scoped query). Previously two: a `SET LOCAL ROLE` statement plus a set_config SELECT.
    //
    // `role` is an ordinary GUC — `SET [LOCAL] ROLE x` is defined as assigning it — so
    // `set_config('role', 'leadwolf_app', true)` is equivalent to `SET LOCAL ROLE leadwolf_app` and can ride
    // along in the same SELECT. (The previous comment here asserted it "cannot be parameterised or merged into
    // a SELECT"; that is only true of the `SET` *statement* syntax, not of the underlying parameter.)
    //
    // Target-list evaluation order is not guaranteed by Postgres, which is safe here: these are three
    // independent GUC assignments, none reads another, and all three are in effect once the statement returns
    // — before `fn` issues any query. Setting `role` mid-statement cannot lock the others out either, since
    // `app.current_*` are custom placeholder GUCs that any role may set.
    //
    // Everything else is unchanged: still transaction-LOCAL (is_local = true, so it reverts at COMMIT and is
    // RDS-Proxy/PgBouncer-safe), still the non-BYPASSRLS app role so RLS is enforced even on a privileged base
    // connection, still NULLIF-fail-closed, and tenant/workspace values stay BOUND parameters (no concat). The
    // role name stays a literal to match the previous behaviour exactly — env.DATABASE_APP_ROLE is not consulted
    // here today, and wiring it in is a separate change.
    //
    // The isolation itests are what prove the role actually took effect: masterGraphIsolation asserts
    // leadwolf_app is denied (SQLSTATE 42501) on the master_* tables and roleModel asserts platform_staff is
    // permission-denied — both of which the RLS-bypassing owner would pass, so they fail loudly if the role
    // assignment ever silently stops applying.
    if (scope.workspaceId) {
      await tx.execute(
        sql`SELECT set_config('role', 'leadwolf_app', true),
                   set_config('app.current_tenant_id', ${scope.tenantId}, true),
                   set_config('app.current_workspace_id', ${scope.workspaceId}, true)`,
      );
    } else {
      // No workspace scope: set only the tenant GUC (workspace GUC stays unset, exactly as before).
      await tx.execute(
        sql`SELECT set_config('role', 'leadwolf_app', true),
                   set_config('app.current_tenant_id', ${scope.tenantId}, true)`,
      );
    }
    return fn(tx);
  });
}

export interface PlatformActor {
  userId: string;
  ip?: string | null;
}

/**
 * Optional TARGET context for the platform-audit row (ADR-0032) — WHAT a privileged action acted on, so the
 * immutable trail names the impersonated tenant/user, the staff user whose role changed, the tenant whose
 * flag was overridden, etc. Omit for plain cross-tenant list reads (no single target).
 */
export interface PlatformAuditTarget {
  targetType?: string;
  targetId?: string;
  tenantId?: string;
  workspaceId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Run `fn` with PLATFORM (cross-tenant) visibility — the audited super-admin path (ADR-0032). The base
 * connection is the DB owner, which bypasses RLS, so this does NOT drop to leadwolf_app (unlike
 * withTenantTx); it can read across EVERY workspace. EVERY call writes a platform_audit_log row in the
 * SAME transaction. MUST only be reached behind a verified platform-admin (`pa`) claim — never from the
 * tenant request flow. (Not withPrivilegedTx: on Neon leadwolf_admin lacks BYPASSRLS and would fail closed.)
 */
export async function withPlatformTx<T>(
  actor: PlatformActor,
  action: string,
  fn: (tx: Tx) => Promise<T>,
  target: PlatformAuditTarget = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO platform_audit_log
            (actor_user_id, action, target_type, target_id, tenant_id, workspace_id, ip, metadata)
          VALUES (${actor.userId}::uuid, ${action}, ${target.targetType ?? null}, ${target.targetId ?? null},
                  ${target.tenantId ?? null}::uuid, ${target.workspaceId ?? null}::uuid, ${actor.ip ?? null},
                  ${target.metadata ? JSON.stringify(target.metadata) : null}::jsonb)`,
    );
    return fn(tx);
  });
}

/**
 * Run `fn` as the DB owner WITHOUT writing an audit row — for UNAUTHENTICATED / high-volume reads of
 * SYSTEM-OWNED, NON-PII platform config ONLY (today: the public pricing catalog — `credit_packs`,
 * `plan_templates`, ADR-0012 transparent self-serve). The base connection is the owner (BYPASSRLS), so this
 * MUST NEVER touch tenant PII — that is `withTenantTx` (drops to leadwolf_app, RLS enforced). There is no
 * actor and no audit: an anonymous catalog read is not an auditable privileged action. Contrast
 * `withPlatformTx`, the audited staff cross-tenant path — never use this where that one is required.
 */
export async function withPlatformReadTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** One platform_audit_log row for a tenant-less / platform-scoped event (ADR-0031 §3, ADR-0032). Unlike
 * withPlatformTx (the staff path, which writes the audit row in the SAME tx as a privileged action), this is
 * a standalone best-effort sink for observational identity events (e.g. password.reset.*): own transaction on
 * the owner connection (RLS-exempt as the table owner; leadwolf_app stays denied), append-only. `action` is
 * typed to the closed platformAuditAction vocabulary at compile time. It does NOT swallow — callers wrap it
 * (recordPlatformAuthEvent) so a failed audit never breaks the auth flow. Never pass codes/tokens/PII. */
export interface PlatformEventInput {
  actorUserId: string; // platform_audit_log.actor_user_id is NOT NULL
  action: PlatformAuditAction;
  targetType?: string | null;
  targetId?: string | null;
  tenantId?: string | null; // a reference (a staff action's target), NOT the RLS scope
  workspaceId?: string | null;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}

export async function recordPlatformEvent(entry: PlatformEventInput): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(
      sql`INSERT INTO platform_audit_log
            (actor_user_id, action, target_type, target_id, tenant_id, workspace_id, ip, metadata)
          VALUES (${entry.actorUserId}::uuid, ${entry.action}, ${entry.targetType ?? null},
                  ${entry.targetId ?? null}, ${entry.tenantId ?? null}::uuid, ${entry.workspaceId ?? null}::uuid,
                  ${entry.ip ?? null}, ${entry.metadata ? JSON.stringify(entry.metadata) : null}::jsonb)`,
    );
  });
}
