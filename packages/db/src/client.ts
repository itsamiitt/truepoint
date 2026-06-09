// client.ts — the postgres.js connection + Drizzle instance, and withTenantTx: the ONLY way a repository
// opens a tenant/workspace-scoped transaction. It sets the RLS GUCs LOCAL to the transaction (RDS Proxy
// transaction pooling resets them per checkout, so they must be set in-tx). 03 §9, architecture-contract §6.

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "@leadwolf/config";
import * as schema from "./schema/index.ts";

// `prepare: false` is required for transaction-pooling proxies (RDS Proxy / PgBouncer).
const client = postgres(env.DATABASE_URL, { max: 10, prepare: false });

export const db = drizzle(client, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

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
      await tx.execute(sql`SELECT set_config('app.current_workspace_id', ${scope.workspaceId}, true)`);
    }
    return fn(tx);
  });
}
