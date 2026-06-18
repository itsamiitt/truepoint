// tagRepository.ts — data access for the record-customization tag layer (ADR-0028, G-REV-6): the `tags`
// definitions + `record_tags` assignments. Workspace-scoped via RLS — every read/write runs under
// withTenantTx (SET LOCAL ROLE leadwolf_app + the tenant/workspace GUCs), so one workspace can never see
// or mutate another's tags. tx-aware methods compose inside one tenant transaction (the core layer maps the
// unique-name conflict to a 409). `color` is stored as a brand palette KEY (apps/web maps it to a token).

import { and, asc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { accounts, contacts } from "../schema/contacts.ts";
import { recordTags, tags } from "../schema/tags.ts";

/** A workspace tag with its live assignment count (usageCount) — the list/governance view-model. */
export interface TagRow {
  id: string;
  name: string;
  color: string;
  usageCount: number;
  createdAt: Date;
}

export interface TagInsert {
  tenantId: string;
  workspaceId: string;
  name: string;
  color: string;
}

export interface TagUpdate {
  name?: string;
  color?: string;
}

export interface AssignInput {
  tenantId: string;
  workspaceId: string;
  tagId: string;
  entity: string;
  recordId: string;
}

/** Drop undefined keys so an UPDATE never overwrites an existing value with `undefined`. */
function definedOnly<T extends object>(v: T): Partial<T> {
  return Object.fromEntries(Object.entries(v).filter(([, val]) => val !== undefined)) as Partial<T>;
}

export const tagRepository = {
  /** True if a tag with this name (case-insensitively) already exists in the workspace — drives the 409. */
  async existsByName(tx: Tx, workspaceId: string, name: string): Promise<boolean> {
    const rows = await tx
      .select({ id: tags.id })
      .from(tags)
      .where(and(eq(tags.workspaceId, workspaceId), sql`lower(${tags.name}) = lower(${name})`))
      .limit(1);
    return rows.length > 0;
  },

  /** Insert a new tag; returns its id. Composed inside the create-tag tx (after the existsByName check). */
  async insert(tx: Tx, values: TagInsert): Promise<string> {
    const rows = await tx.insert(tags).values(values).returning({ id: tags.id });
    return rows[0]!.id;
  },

  /** True if the record (contact|account) exists in the caller's workspace (RLS-scoped) — guards assign so a
   *  tag can't be attached to a foreign or non-existent record id (record_tags has no FK to the entity). */
  async recordExists(tx: Tx, entity: string, recordId: string): Promise<boolean> {
    if (entity === "account") {
      const r = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.id, recordId))
        .limit(1);
      return r.length > 0;
    }
    const r = await tx
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.id, recordId))
      .limit(1);
    return r.length > 0;
  },

  /** Find one tag by id within the caller's workspace (RLS already scopes it); null if absent. */
  async findById(tx: Tx, id: string): Promise<{ id: string; name: string; color: string } | null> {
    const rows = await tx
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(tags)
      .where(eq(tags.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Merge non-undefined fields into a tag (rename/recolor). The updated_at trigger bumps the timestamp.
   *  No-op when nothing is set — Drizzle throws "No values to set" on an empty .set(), and the updated_at
   *  comes from the DB trigger (not an injected column), so the set can legitimately be empty. */
  async update(tx: Tx, id: string, values: TagUpdate): Promise<void> {
    const set = definedOnly(values);
    if (Object.keys(set).length === 0) return;
    await tx.update(tags).set(set).where(eq(tags.id, id));
  },

  /** Delete a tag (record_tags rows cascade via the FK). RLS makes a cross-workspace delete a no-op. */
  async remove(tx: Tx, id: string): Promise<void> {
    await tx.delete(tags).where(eq(tags.id, id));
  },

  /** All workspace tags, alphabetical, each with its live assignment count. Workspace-scoped via RLS. */
  async listByWorkspace(scope: TenantScope): Promise<TagRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: tags.id,
          name: tags.name,
          color: tags.color,
          createdAt: tags.createdAt,
          usageCount: sql<number>`count(${recordTags.id})::int`,
        })
        .from(tags)
        .leftJoin(recordTags, eq(recordTags.tagId, tags.id))
        .groupBy(tags.id)
        .orderBy(asc(tags.name)),
    );
  },

  /** The tags assigned to one record (entity + record_id), alphabetical. Workspace-scoped via RLS. */
  async listForRecord(
    tx: Tx,
    entity: string,
    recordId: string,
  ): Promise<{ id: string; name: string; color: string }[]> {
    return tx
      .select({ id: tags.id, name: tags.name, color: tags.color })
      .from(recordTags)
      .innerJoin(tags, eq(tags.id, recordTags.tagId))
      .where(and(eq(recordTags.entity, entity), eq(recordTags.recordId, recordId)))
      .orderBy(asc(tags.name));
  },

  /** The tags assigned to one record, in its own withTenantTx (the RecordDetail "Tags" section reads this). */
  async tagsForRecord(
    scope: TenantScope,
    entity: string,
    recordId: string,
  ): Promise<{ id: string; name: string; color: string }[]> {
    return withTenantTx(scope, (tx) => tagRepository.listForRecord(tx, entity, recordId));
  },

  /** The record ids carrying a given tag (filter-by-tag). Workspace-scoped via RLS. */
  async listRecordsByTag(scope: TenantScope, tagId: string, entity: string): Promise<string[]> {
    return withTenantTx(scope, async (tx) => {
      const rows = await tx
        .select({ recordId: recordTags.recordId })
        .from(recordTags)
        .where(and(eq(recordTags.tagId, tagId), eq(recordTags.entity, entity)));
      return rows.map((r) => r.recordId);
    });
  },

  /** Attach a tag to a record. Idempotent: a duplicate (tag, entity, record) link is silently ignored. */
  async assign(tx: Tx, input: AssignInput): Promise<void> {
    await tx
      .insert(recordTags)
      .values({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        tagId: input.tagId,
        entity: input.entity,
        recordId: input.recordId,
      })
      .onConflictDoNothing({
        target: [recordTags.tagId, recordTags.entity, recordTags.recordId],
      });
  },

  /** Detach a tag from a record. A no-op if the link doesn't exist (or belongs to another workspace). */
  async unassign(tx: Tx, tagId: string, entity: string, recordId: string): Promise<void> {
    await tx
      .delete(recordTags)
      .where(
        and(
          eq(recordTags.tagId, tagId),
          eq(recordTags.entity, entity),
          eq(recordTags.recordId, recordId),
        ),
      );
  },
};
