// pipelineStageRepository.ts — data access for the workspace pipeline-stage layer (G-REV-7, ADR-0028). CRUD
// over `pipeline_stages` plus the tx-aware primitives the core assignment logic composes: fetch a stage and
// roll a contact's `pipeline_stage_id` + `outreach_status` up together inside ONE withTenantTx so the mapping
// invariant can never be observed half-applied. All scoped paths run through RLS (workspace isolation). The
// closed `maps_to_status` set is the canonical OutreachStatus from @leadwolf/types — narrowed at the edge,
// stored widened like every enum in this package. This layer never opens the canonical enum; it references it.

import type { OutreachStatus } from "@leadwolf/types";
import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { contacts } from "../schema/contacts.ts";
import { pipelineStages } from "../schema/pipelineStages.ts";

/** The columns the create path computes. `ordering`/`isDefault` default in SQL; status is the canonical enum. */
export interface StageCreateValues {
  tenantId: string;
  workspaceId: string;
  name: string;
  mapsToStatus: OutreachStatus;
  ordering?: number;
  isDefault?: boolean;
}

/** Sparse stage patch — undefined fields are left untouched. `mapsToStatus` stays the canonical enum. */
export interface StageUpdateValues {
  name?: string;
  mapsToStatus?: OutreachStatus;
  ordering?: number;
  isDefault?: boolean;
  archived?: boolean;
}

/** A stage row read by the management panel + the record StageSelector (all non-PII; serializable). */
export interface StageRecord {
  id: string;
  name: string;
  mapsToStatus: string; // closed set (OutreachStatus); widened on read like the rest of the package
  ordering: number;
  isDefault: boolean;
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

function toRecord(r: typeof pipelineStages.$inferSelect): StageRecord {
  return {
    id: r.id,
    name: r.name,
    mapsToStatus: r.mapsToStatus,
    ordering: r.ordering,
    isDefault: r.isDefault,
    archived: r.archived,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export const pipelineStageRepository = {
  /** The next ordering position for a workspace (max+1, 0 when empty). Tx-aware so the append is atomic. */
  async nextOrdering(tx: Tx, workspaceId: string): Promise<number> {
    const rows = await tx
      .select({ max: sql<number>`coalesce(max(${pipelineStages.ordering}), -1)` })
      .from(pipelineStages)
      .where(eq(pipelineStages.workspaceId, workspaceId));
    return (rows[0]?.max ?? -1) + 1;
  },

  /** Insert a stage; returns its id. Tx-aware so core can clear other defaults in the same tx. */
  async insert(tx: Tx, values: StageCreateValues): Promise<string> {
    const rows = await tx
      .insert(pipelineStages)
      .values(values)
      .returning({ id: pipelineStages.id });
    return rows[0]!.id;
  },

  /** Read a stage by id (RLS restricts it to the caller's workspace). Tx-aware. Null when not visible. */
  async getById(tx: Tx, stageId: string): Promise<StageRecord | null> {
    const rows = await tx
      .select()
      .from(pipelineStages)
      .where(eq(pipelineStages.id, stageId))
      .limit(1);
    return rows[0] ? toRecord(rows[0]) : null;
  },

  /** Merge non-undefined fields into a stage. Tx-aware. `updated_at` is maintained by the RLS trigger. */
  async update(tx: Tx, stageId: string, values: StageUpdateValues): Promise<void> {
    const set = definedOnly(values);
    if (Object.keys(set).length === 0) return;
    await tx.update(pipelineStages).set(set).where(eq(pipelineStages.id, stageId));
  },

  /** Clear `is_default` on every OTHER live stage in the workspace (so at most one default exists). Tx-aware. */
  async clearDefaultsExcept(tx: Tx, workspaceId: string, keepStageId: string): Promise<void> {
    await tx
      .update(pipelineStages)
      .set({ isDefault: false })
      .where(
        and(
          eq(pipelineStages.workspaceId, workspaceId),
          eq(pipelineStages.isDefault, true),
          ne(pipelineStages.id, keepStageId),
        ),
      );
  },

  /**
   * Assign (or clear) a contact's stage AND roll its `outreach_status` up to the stage's `maps_to_status`
   * in ONE statement. `mapsToStatus` is undefined only when clearing (stageId null) — clearing leaves the
   * existing status untouched (the rollup is one-way). Tx-aware so the assignment is atomic with any audit.
   * Returns the contact's resulting `outreach_status` (RETURNING) so the caller reports the real post-write
   * status without a second read — null when the contact isn't visible in the workspace (RLS-scoped UPDATE).
   */
  async assignContactStage(
    tx: Tx,
    contactId: string,
    stageId: string | null,
    mapsToStatus: OutreachStatus | undefined,
  ): Promise<string | null> {
    const set: { pipelineStageId: string | null; outreachStatus?: OutreachStatus } = {
      pipelineStageId: stageId,
    };
    if (stageId !== null && mapsToStatus !== undefined) set.outreachStatus = mapsToStatus;
    const rows = await tx
      .update(contacts)
      .set(set)
      .where(eq(contacts.id, contactId))
      .returning({ outreachStatus: contacts.outreachStatus });
    return rows[0]?.outreachStatus ?? null;
  },

  /** List a workspace's stages in display order. `includeArchived` defaults to false (the active board). */
  async list(scope: TenantScope, includeArchived = false): Promise<StageRecord[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select()
        .from(pipelineStages)
        .where(includeArchived ? undefined : eq(pipelineStages.archived, false))
        .orderBy(asc(pipelineStages.ordering), asc(pipelineStages.createdAt));
      return rows.map(toRecord);
    });
  },

  /** Count contacts currently assigned to a stage (the management panel shows it before archive/delete). */
  async contactCount(scope: TenantScope, stageId: string): Promise<number> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(and(eq(contacts.pipelineStageId, stageId), isNull(contacts.deletedAt)));
      return rows[0]?.n ?? 0;
    });
  },
};
