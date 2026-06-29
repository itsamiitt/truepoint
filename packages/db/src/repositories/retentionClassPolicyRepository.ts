// retentionClassPolicyRepository.ts — data access for the GLOBAL retention POLICY store (retention_class_policies, data-
// management backlog #6; design 16-retention-engine-design.md). One row per data class: its TTL (null = never)
// and its disabled|shadow|enforce mode. The table is platform-managed — reads run on any path (the app role has
// a SELECT-only RLS policy for in-request evaluation); the upsert here is for the FUTURE admin surface and must
// run on the owner/withPlatformTx path (under FORCE RLS the app role has no write policy, so it cannot write).
// Tx-aware (every method takes a Tx) like the rest of this package; rows map onto the shipped RetentionPolicy
// contract from @leadwolf/types (the single source of truth shared with the sweep). No deletion logic here.

import type { RetentionDataClass, RetentionMode, RetentionPolicy } from "@leadwolf/types";
import { asc, eq } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { retentionClassPolicies } from "../schema/retention.ts";

/** Map a widened DB row onto the closed RetentionPolicy contract (narrowing the varchar enums at the edge). */
function toPolicy(row: typeof retentionClassPolicies.$inferSelect): RetentionPolicy {
  return {
    dataClass: row.dataClass as RetentionDataClass,
    ttlDays: row.ttlDays,
    mode: row.mode as RetentionMode,
  };
}

export const retentionClassPolicyRepository = {
  /** Every policy, ordered by data class (the stable seed order the engine iterates). Read path (any tx). */
  async listPolicies(tx: Tx): Promise<RetentionPolicy[]> {
    const rows = await tx
      .select()
      .from(retentionClassPolicies)
      .orderBy(asc(retentionClassPolicies.dataClass));
    return rows.map(toPolicy);
  },

  /** A single class's policy by its natural PK, or null if no row exists for it. */
  async getPolicy(tx: Tx, dataClass: RetentionDataClass): Promise<RetentionPolicy | null> {
    const rows = await tx
      .select()
      .from(retentionClassPolicies)
      .where(eq(retentionClassPolicies.dataClass, dataClass))
      .limit(1);
    return rows[0] ? toPolicy(rows[0]) : null;
  },

  /**
   * Define or update a class's policy (idempotent on data_class) — for the FUTURE admin surface. MUST run on the
   * owner/withPlatformTx path: under FORCE RLS the app role has no write policy on retention_class_policies, so a write
   * attempted on the app path fails closed. Touches updated_at on every change.
   */
  async upsertPolicy(tx: Tx, policy: RetentionPolicy): Promise<void> {
    await tx
      .insert(retentionClassPolicies)
      .values({ dataClass: policy.dataClass, ttlDays: policy.ttlDays, mode: policy.mode })
      .onConflictDoUpdate({
        target: retentionClassPolicies.dataClass,
        set: { ttlDays: policy.ttlDays, mode: policy.mode, updatedAt: new Date() },
      });
  },
};
