// planTemplateRepository.ts — data access for plan_templates (13a Area 5, plan/entitlement config). Every
// method takes the transaction handed by withPlatformTx (owner connection, audited). Upsert is keyed on the
// natural `key`. Reads are bounded — no unbounded scans (ADR-0032).

import { asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client.ts";
import { planTemplates } from "../schema/platformOps.ts";

export interface PlanTemplateRow {
  key: string;
  name: string;
  seatLimit: number;
  workspaceLimit: number | null;
  monthlyCreditGrant: number | null;
  features: Record<string, boolean>;
  active: boolean;
  sortOrder: number;
  updatedAt: Date;
}

export interface UpsertPlanTemplateInput {
  key: string;
  name: string;
  seatLimit: number;
  workspaceLimit: number | null;
  monthlyCreditGrant: number | null;
  features: Record<string, boolean>;
  sortOrder: number;
}

const TEMPLATE_LIMIT = 200;

const TEMPLATE_COLS = {
  key: planTemplates.key,
  name: planTemplates.name,
  seatLimit: planTemplates.seatLimit,
  workspaceLimit: planTemplates.workspaceLimit,
  monthlyCreditGrant: planTemplates.monthlyCreditGrant,
  features: planTemplates.features,
  active: planTemplates.active,
  sortOrder: planTemplates.sortOrder,
  updatedAt: planTemplates.updatedAt,
};

export const planTemplateRepository = {
  /** The full catalog (active + retired), ordered by sortOrder then name, bounded. */
  async list(tx: Tx): Promise<PlanTemplateRow[]> {
    const rows = await tx
      .select(TEMPLATE_COLS)
      .from(planTemplates)
      .orderBy(asc(planTemplates.sortOrder), asc(planTemplates.name))
      .limit(TEMPLATE_LIMIT);
    return rows as PlanTemplateRow[];
  },

  /** Create or update a template (idempotent on `key`); keeps `active` (toggled separately) but bumps
   *  updated_at. Returns the resulting row. */
  async upsert(tx: Tx, input: UpsertPlanTemplateInput): Promise<PlanTemplateRow> {
    const values = {
      key: input.key,
      name: input.name,
      seatLimit: input.seatLimit,
      workspaceLimit: input.workspaceLimit,
      monthlyCreditGrant: input.monthlyCreditGrant,
      features: input.features,
      sortOrder: input.sortOrder,
    };
    const [row] = await tx
      .insert(planTemplates)
      .values(values)
      .onConflictDoUpdate({
        target: planTemplates.key,
        set: {
          name: input.name,
          seatLimit: input.seatLimit,
          workspaceLimit: input.workspaceLimit,
          monthlyCreditGrant: input.monthlyCreditGrant,
          features: input.features,
          sortOrder: input.sortOrder,
          updatedAt: sql`now()`,
        },
      })
      .returning(TEMPLATE_COLS);
    return row as PlanTemplateRow;
  },

  /** Fetch one template by its natural key, or null (13a Area 1 plan-override reads it before applying). */
  async getByKey(tx: Tx, key: string): Promise<PlanTemplateRow | null> {
    const [row] = await tx
      .select(TEMPLATE_COLS)
      .from(planTemplates)
      .where(eq(planTemplates.key, key))
      .limit(1);
    return (row as PlanTemplateRow) ?? null;
  },

  /** Toggle a template's availability. Returns rows touched (0 = unknown key → caller raises 404). */
  async setActive(tx: Tx, key: string, active: boolean): Promise<number> {
    const updated = await tx
      .update(planTemplates)
      .set({ active, updatedAt: sql`now()` })
      .where(eq(planTemplates.key, key))
      .returning({ key: planTemplates.key });
    return updated.length;
  },
};
