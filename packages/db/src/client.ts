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
const client = postgres(env.DATABASE_URL, { max: 10, prepare: false });

export const db = drizzle(client, { schema });
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
  await client.end({ timeout: 5 });
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
 * There are no GUCs — the forge tables carry no workspace_id (isolation is schema+role, the same-repo firewall).
 * `SET LOCAL ROLE` is transaction-local (RDS-Proxy/PgBouncer-safe). Promotion into master_* still uses withErTx.
 */
export async function withForgeTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE leadwolf_forge`);
    return fn(tx);
  });
}

export interface TenantScope {
  tenantId: string;
  workspaceId?: string;
}

/**
 * Run `fn` inside a transaction with the RLS GUCs set LOCAL — the only sanctioned scoped-query path.
 * `SET LOCAL ROLE leadwolf_app` drops to the **non-BYPASSRLS** app role for the scope of the tx, so RLS is
 * actually enforced even when the base connection is privileged (the documented dev/superuser case). Both
 * the role and the GUCs are transaction-local (RDS-Proxy-safe). 03 §9, architecture-contract §6.
 */
export async function withTenantTx<T>(scope: TenantScope, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // RLS setup, kept to TWO round-trips instead of three (perf root cause #7 — the per-read latency floor
    // under every authenticated endpoint). `SET LOCAL ROLE` is a utility command that cannot be parameterised
    // or merged into a SELECT, so it stays its own statement; both `set_config` calls collapse into a SINGLE
    // parameterised SELECT (one Parse+Bind+Execute) when a workspace is present. The role + GUCs are still set
    // LOCAL, in this transaction, BEFORE any query runs, with the same NULLIF-fail-closed semantics — so RLS
    // isolation is byte-for-byte identical to setting them separately. Values stay BOUND (no string concat).
    await tx.execute(sql`SET LOCAL ROLE leadwolf_app`);
    if (scope.workspaceId) {
      await tx.execute(
        sql`SELECT set_config('app.current_tenant_id', ${scope.tenantId}, true),
                   set_config('app.current_workspace_id', ${scope.workspaceId}, true)`,
      );
    } else {
      // No workspace scope: set only the tenant GUC (workspace GUC stays unset, exactly as before).
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${scope.tenantId}, true)`);
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
