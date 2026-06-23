// client.ts — the postgres.js connection + Drizzle instance, and withTenantTx: the ONLY way a repository
// opens a tenant/workspace-scoped transaction. It sets the RLS GUCs LOCAL to the transaction (RDS Proxy
// transaction pooling resets them per checkout, so they must be set in-tx). 03 §9, architecture-contract §6.

import { env } from "@leadwolf/config";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

// `prepare: false` is required for transaction-pooling proxies (RDS Proxy / PgBouncer).
const client = postgres(env.DATABASE_URL, { max: 10, prepare: false });

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
    await tx.execute(sql`SET LOCAL ROLE leadwolf_app`);
    await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${scope.tenantId}, true)`);
    if (scope.workspaceId) {
      await tx.execute(
        sql`SELECT set_config('app.current_workspace_id', ${scope.workspaceId}, true)`,
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
