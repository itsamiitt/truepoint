// retentionPolicyRepository.ts — data access for retention_policies (13a Area 8). Every method takes the
// transaction handed by withPlatformTx (owner connection, audited). create/update by id (field can be null =
// whole entity, so there is no natural upsert key). Reads are bounded — no unbounded scans (ADR-0032).

import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { retentionPolicies } from "../schema/platformOps.ts";

export interface RetentionPolicyRow {
  id: string;
  entity: string;
  field: string | null;
  retentionDays: number;
  reason: string | null;
  active: boolean;
  updatedAt: Date;
}

export interface RetentionPolicyWrite {
  entity: string;
  field: string | null;
  retentionDays: number;
  reason: string | null;
}

const LIMIT = 200;

const COLS = {
  id: retentionPolicies.id,
  entity: retentionPolicies.entity,
  field: retentionPolicies.field,
  retentionDays: retentionPolicies.retentionDays,
  reason: retentionPolicies.reason,
  active: retentionPolicies.active,
  updatedAt: retentionPolicies.updatedAt,
};

export const retentionPolicyRepository = {
  /** The full list (active + retired), ordered by entity then field, bounded. */
  async list(tx: Tx): Promise<RetentionPolicyRow[]> {
    return tx
      .select(COLS)
      .from(retentionPolicies)
      .orderBy(asc(retentionPolicies.entity), asc(retentionPolicies.field))
      .limit(LIMIT);
  },

  /** Create a policy (active by default). */
  async create(
    tx: Tx,
    input: RetentionPolicyWrite & { createdByUserId: string },
  ): Promise<RetentionPolicyRow> {
    const [row] = await tx
      .insert(retentionPolicies)
      .values({
        entity: input.entity,
        field: input.field,
        retentionDays: input.retentionDays,
        reason: input.reason,
        createdByUserId: input.createdByUserId,
      })
      .returning(COLS);
    return row as RetentionPolicyRow;
  },

  /** Update a policy by id. Returns rows touched (0 = unknown id → caller raises 404). */
  async update(tx: Tx, id: string, input: RetentionPolicyWrite): Promise<number> {
    const updated = await tx
      .update(retentionPolicies)
      .set({
        entity: input.entity,
        field: input.field,
        retentionDays: input.retentionDays,
        reason: input.reason,
        updatedAt: sql`now()`,
      })
      .where(eq(retentionPolicies.id, id))
      .returning({ id: retentionPolicies.id });
    return updated.length;
  },

  /** Toggle a policy on/off. Returns rows touched (0 = unknown id). */
  async setActive(tx: Tx, id: string, active: boolean): Promise<number> {
    const updated = await tx
      .update(retentionPolicies)
      .set({ active, updatedAt: sql`now()` })
      .where(eq(retentionPolicies.id, id))
      .returning({ id: retentionPolicies.id });
    return updated.length;
  },
};
