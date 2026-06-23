// sequenceRepository.ts — data access for outreach sequence definitions + their ordered steps (outreach
// domain, 03 §7, ADR-0009). Tx-aware pieces the core enroll/send transactions compose inside ONE
// withTenantTx, plus the aggregated list the sequences screen renders. Status/channel come back as plain
// strings; the closed vocabularies live in @leadwolf/types (packages/types/src/outreach.ts) and core narrows.

import { and, asc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { outreachLog, outreachSequences, outreachSteps } from "../schema/outreach.ts";

export interface SequenceInsert {
  tenantId: string;
  workspaceId: string;
  name: string;
  fromAddress?: string | null;
  physicalAddress?: string | null;
  createdByUserId?: string | null;
}

export interface SequenceRecord {
  id: string;
  name: string;
  status: string;
  fromAddress: string | null;
  physicalAddress: string | null;
}

export interface StepInsert {
  tenantId: string;
  workspaceId: string;
  sequenceId: string;
  stepOrder: number;
  channel: string;
  delayHours: number;
  subject?: string | null;
  body: string;
}

export interface StepRecord {
  id: string;
  stepOrder: number;
  channel: string;
  delayHours: number;
  subject: string | null;
  body: string;
}

export interface SequenceSummaryRow {
  id: string;
  name: string;
  status: string;
  stepCount: number;
  enrolledCount: number;
}

/** The outreach-engine aggregate for the Home dashboard (the `sent` count is derived by the api from
 * activities — email_sent — and merged in, since it lives in the activity domain, not here). */
export interface PerformanceSnapshotRow {
  activeSequences: number;
  enrolled: number;
  replied: number;
}

export const sequenceRepository = {
  async insert(tx: Tx, row: SequenceInsert): Promise<string> {
    const inserted = await tx
      .insert(outreachSequences)
      .values(row)
      .returning({ id: outreachSequences.id });
    return inserted[0]!.id;
  },

  /** Load a sequence inside the caller's tx. Null when it doesn't exist in the scoped workspace (RLS). */
  async getById(tx: Tx, sequenceId: string): Promise<SequenceRecord | null> {
    const rows = await tx
      .select({
        id: outreachSequences.id,
        name: outreachSequences.name,
        status: outreachSequences.status,
        fromAddress: outreachSequences.fromAddress,
        physicalAddress: outreachSequences.physicalAddress,
      })
      .from(outreachSequences)
      .where(eq(outreachSequences.id, sequenceId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Highest step_order in the sequence (0 when empty) — the next step is max+1, computed in-tx. */
  async maxStepOrder(tx: Tx, sequenceId: string): Promise<number> {
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(${outreachSteps.stepOrder}), 0)::int` })
      .from(outreachSteps)
      .where(eq(outreachSteps.sequenceId, sequenceId));
    return Number(rows[0]?.max ?? 0);
  },

  async insertStep(tx: Tx, row: StepInsert): Promise<string> {
    const inserted = await tx.insert(outreachSteps).values(row).returning({ id: outreachSteps.id });
    return inserted[0]!.id;
  },

  /** The step at a given 1-based position, or null past the end of the sequence. */
  async stepAt(tx: Tx, sequenceId: string, stepOrder: number): Promise<StepRecord | null> {
    const rows = await tx
      .select({
        id: outreachSteps.id,
        stepOrder: outreachSteps.stepOrder,
        channel: outreachSteps.channel,
        delayHours: outreachSteps.delayHours,
        subject: outreachSteps.subject,
        body: outreachSteps.body,
      })
      .from(outreachSteps)
      .where(and(eq(outreachSteps.sequenceId, sequenceId), eq(outreachSteps.stepOrder, stepOrder)))
      .limit(1);
    return rows[0] ?? null;
  },

  async countSteps(tx: Tx, sequenceId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(outreachSteps)
      .where(eq(outreachSteps.sequenceId, sequenceId));
    return Number(rows[0]?.n ?? 0);
  },

  /** The sequences list with step/enrollment counts (GET /outreach/sequences). Workspace-scoped via RLS. */
  async listSummaries(scope: TenantScope): Promise<SequenceSummaryRow[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({
          id: outreachSequences.id,
          name: outreachSequences.name,
          status: outreachSequences.status,
          stepCount: sql<number>`(SELECT count(*)::int FROM ${outreachSteps}
            WHERE ${outreachSteps.sequenceId} = ${outreachSequences.id})`,
          enrolledCount: sql<number>`(SELECT count(*)::int FROM ${outreachLog}
            WHERE ${outreachLog.sequenceId} = ${outreachSequences.id})`,
        })
        .from(outreachSequences)
        .orderBy(asc(outreachSequences.name));
      return rows.map((r) => ({
        ...r,
        stepCount: Number(r.stepCount),
        enrolledCount: Number(r.enrolledCount),
      }));
    });
  },

  /**
   * Aggregate outreach counts for the Home dashboard: active = sequences with status 'active';
   * enrolled = total outreach_log rows; replied = outreach_log rows with status 'replied'.
   * Workspace-scoped via RLS (all three reads run under the same scoped transaction). Pass `tx` to run on
   * a caller's existing scoped transaction (e.g. the Home summary fan-out); omit it for a standalone read.
   */
  async performanceSnapshot(scope: TenantScope, tx?: Tx): Promise<PerformanceSnapshotRow> {
    const run = async (t: Tx): Promise<PerformanceSnapshotRow> => {
      const count = sql<number>`count(*)::int`;
      const [active] = await t
        .select({ n: count })
        .from(outreachSequences)
        .where(eq(outreachSequences.status, "active"));
      const [enrolled] = await t.select({ n: count }).from(outreachLog);
      const [replied] = await t
        .select({ n: count })
        .from(outreachLog)
        .where(eq(outreachLog.status, "replied"));
      return {
        activeSequences: Number(active?.n ?? 0),
        enrolled: Number(enrolled?.n ?? 0),
        replied: Number(replied?.n ?? 0),
      };
    };
    return tx ? run(tx) : withTenantTx(scope, run);
  },
};
