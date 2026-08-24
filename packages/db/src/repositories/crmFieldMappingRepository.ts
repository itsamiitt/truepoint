// crmFieldMappingRepository.ts — per-(connection, object, field) direction/authority/transform
// (crm-sync 00 §4.3). WORKSPACE-scoped under FORCE RLS; every call runs inside withTenantTx.
//
// The starter set is seeded IN CODE at connect time rather than in the migration (00 §4.3): the defaults are
// per-provider and per-connection, and a migration cannot know which providers a workspace will connect.

import { and, asc, eq, sql } from "drizzle-orm";
import { type Tx, db } from "../client.ts";
import { crmFieldMappings } from "../schema/crm.ts";

export interface CrmFieldMappingRow {
  objectType: string;
  tpField: string;
  crmField: string;
  direction?: string;
  authority?: string | null;
  confThreshold?: number | null;
  transform?: string;
  isDedupKey?: boolean;
  enabled?: boolean;
}

export interface CrmFieldMappingRecord {
  id: string;
  objectType: string;
  tpField: string;
  crmField: string;
  direction: string;
  authority: string;
  confThreshold: string | null;
  transform: string;
  isRequired: boolean;
  isDedupKey: boolean;
  enabled: boolean;
}

export const crmFieldMappingRepository = {
  /**
   * Seed the starter mapping set for a connection.
   *
   * `onConflictDoNothing` on the (connection, object, tpField, crmField) unique index, so a RECONNECT does
   * not clobber mappings the customer has since tuned. That is the whole reason this is not an upsert: the
   * defaults are a starting point, and silently reverting a customer's field policy on reconnect would be a
   * data-authority change nobody asked for.
   *
   * Returns the number of rows actually inserted, so the caller can tell a first connect from a reconnect.
   */
  async seedDefaults(
    tx: Tx,
    scope: { tenantId: string; workspaceId: string },
    connectionId: string,
    rows: CrmFieldMappingRow[],
  ): Promise<number> {
    if (rows.length === 0) return 0;
    // batch-insert-bounds-ok: one row per mapped CRM field — bounded by the connector's schema (dozens), not
    // by any user-supplied volume.
    const inserted = await tx
      .insert(crmFieldMappings)
      .values(
        rows.map((r) => ({
          tenantId: scope.tenantId,
          workspaceId: scope.workspaceId,
          connectionId,
          objectType: r.objectType,
          tpField: r.tpField,
          crmField: r.crmField,
          direction: r.direction ?? "inbound",
          authority: r.authority ?? "crm",
          // numeric(4,3) round-trips as a string in postgres.js; store it as one so the driver does not
          // hand back a float that fails an exact comparison later.
          confThreshold: r.confThreshold == null ? null : String(r.confThreshold),
          transform: r.transform ?? "passthrough",
          isDedupKey: r.isDedupKey ?? false,
          enabled: r.enabled ?? true,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: crmFieldMappings.id });
    return inserted.length;
  },

  /** Every mapping for a connection, stable order (the admin mapping editor's read). */
  async listByConnection(tx: Tx, connectionId: string): Promise<CrmFieldMappingRecord[]> {
    return tx
      .select({
        id: crmFieldMappings.id,
        objectType: crmFieldMappings.objectType,
        tpField: crmFieldMappings.tpField,
        crmField: crmFieldMappings.crmField,
        direction: crmFieldMappings.direction,
        authority: crmFieldMappings.authority,
        confThreshold: crmFieldMappings.confThreshold,
        transform: crmFieldMappings.transform,
        isRequired: crmFieldMappings.isRequired,
        isDedupKey: crmFieldMappings.isDedupKey,
        enabled: crmFieldMappings.enabled,
      })
      .from(crmFieldMappings)
      .where(eq(crmFieldMappings.connectionId, connectionId))
      .orderBy(asc(crmFieldMappings.objectType), asc(crmFieldMappings.tpField));
  },

  /**
   * The ENABLED mappings a sync run actually applies, for one object type.
   *
   * Filtering on `enabled` here rather than at the call site means a disabled mapping cannot be applied by a
   * runner that forgot to check — the same reasoning as safeColumns on the credential.
   */
  async listActive(
    tx: Tx,
    connectionId: string,
    objectType: string,
  ): Promise<CrmFieldMappingRecord[]> {
    return tx
      .select({
        id: crmFieldMappings.id,
        objectType: crmFieldMappings.objectType,
        tpField: crmFieldMappings.tpField,
        crmField: crmFieldMappings.crmField,
        direction: crmFieldMappings.direction,
        authority: crmFieldMappings.authority,
        confThreshold: crmFieldMappings.confThreshold,
        transform: crmFieldMappings.transform,
        isRequired: crmFieldMappings.isRequired,
        isDedupKey: crmFieldMappings.isDedupKey,
        enabled: crmFieldMappings.enabled,
      })
      .from(crmFieldMappings)
      .where(
        and(
          eq(crmFieldMappings.connectionId, connectionId),
          eq(crmFieldMappings.objectType, objectType),
          eq(crmFieldMappings.enabled, true),
        ),
      )
      .orderBy(asc(crmFieldMappings.tpField));
  },

  /**
   * Update ONE mapping's policy fields. RLS-scoped; returns false when the row is not in this workspace.
   *
   * Only direction / authority / enabled are editable. tpField and crmField are NOT: changing which columns
   * a mapping joins would silently re-point history — the provenance already written under the old pair
   * would now describe a different field. Re-pointing is a delete-and-create, which is visible.
   */
  async updatePolicy(
    tx: Tx,
    mappingId: string,
    patch: {
      direction?: "inbound" | "outbound" | "bidirectional" | "disabled";
      authority?: "crm" | "truepoint";
      enabled?: boolean;
    },
  ): Promise<boolean> {
    const set: Record<string, unknown> = { updatedAt: sql`now()` };
    if (patch.direction !== undefined) set.direction = patch.direction;
    if (patch.authority !== undefined) set.authority = patch.authority;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    // Only updatedAt would mean an empty patch — refuse rather than bump the timestamp for nothing.
    if (Object.keys(set).length === 1) return false;

    const updated = await tx
      .update(crmFieldMappings)
      .set(set)
      .where(eq(crmFieldMappings.id, mappingId))
      .returning({ id: crmFieldMappings.id });
    return updated.length === 1;
  },

  /** Count a connection's mappings on the OWNER connection — for the cross-tenant staff console only. */
  async countForConnectionUnscoped(connectionId: string): Promise<number> {
    const rows = await db
      .select({ id: crmFieldMappings.id })
      .from(crmFieldMappings)
      .where(eq(crmFieldMappings.connectionId, connectionId));
    return rows.length;
  },
};
