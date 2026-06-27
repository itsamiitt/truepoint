// emailTemplateRepository.ts — data access for email_template + email_template_version (M12 P2, 01, 09).
// WORKSPACE-scoped via RLS; OWNER-scope (D8) is applied here as an app filter (owner OR shared). Versions are
// immutable + append-only; current_version_id caches the latest. The list read joins the current version so
// the API returns the TemplateSummary shape (id/name/channel/subject/body/updatedAt) the web stub expects.

import { and, desc, eq, isNotNull, or, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { emailTemplate, emailTemplateVersion } from "../schema/email.ts";

export interface TemplateInsert {
  tenantId: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  channel: string;
}

export interface VersionInsert {
  tenantId: string;
  workspaceId: string;
  templateId: string;
  version: number;
  subject: string | null;
  body: string;
  createdByUserId: string;
}

/** The list row the GET /templates surface returns (matches the web TemplateSummary). */
export interface TemplateSummaryRow {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  updatedAt: Date;
}

export interface TemplateRecord {
  id: string;
  ownerUserId: string | null;
  name: string;
  channel: string;
  status: string;
  shared: boolean;
  currentVersionId: string | null;
}

/** The full editor view of one template — metadata + current-version content + version number. */
export interface TemplateDetailRow {
  id: string;
  ownerUserId: string | null;
  name: string;
  channel: string;
  status: string;
  shared: boolean;
  subject: string | null;
  body: string | null;
  currentVersion: number | null;
  updatedAt: Date;
}

/** One immutable row of a template's history (newest first). */
export interface TemplateVersionRow {
  version: number;
  subject: string | null;
  body: string;
  createdByUserId: string | null;
  createdAt: Date;
}

/** Opaque keyset cursor for the template library list (newest-updated first). */
export interface TemplateListCursor {
  /** PG-native full-precision `updated_at::text` (micros preserved) — exact keyset, no JS-Date ms-truncation loss. */
  updatedAtText: string;
  id: string;
}

/** A library list row plus its exact keyset key — the caller encodes `cursorKey`+`id` into the opaque cursor. */
export type TemplateListRow = TemplateSummaryRow & { cursorKey: string };

export const emailTemplateRepository = {
  async insertTemplate(tx: Tx, row: TemplateInsert): Promise<string> {
    const inserted = await tx.insert(emailTemplate).values(row).returning({ id: emailTemplate.id });
    return inserted[0]!.id;
  },

  async insertVersion(tx: Tx, row: VersionInsert): Promise<string> {
    const inserted = await tx
      .insert(emailTemplateVersion)
      .values(row)
      .returning({ id: emailTemplateVersion.id });
    return inserted[0]!.id;
  },

  /** Point the template at its newest version (cache pointer) + bump updated_at via the trigger. */
  async setCurrentVersion(tx: Tx, templateId: string, versionId: string): Promise<void> {
    await tx
      .update(emailTemplate)
      .set({ currentVersionId: versionId, updatedAt: sql`now()` })
      .where(eq(emailTemplate.id, templateId));
  },

  /** Next version number for a template (max+1), computed in-tx so concurrent edits collide on the unique key. */
  async nextVersion(tx: Tx, templateId: string): Promise<number> {
    const rows = (await tx.execute(
      sql`SELECT COALESCE(MAX(version), 0) + 1 AS next FROM email_template_version
          WHERE template_id = ${templateId}`,
    )) as unknown as Array<{ next: number }>;
    return Number(rows[0]?.next ?? 1);
  },

  async getById(tx: Tx, templateId: string): Promise<TemplateRecord | null> {
    const rows = await tx
      .select({
        id: emailTemplate.id,
        ownerUserId: emailTemplate.ownerUserId,
        name: emailTemplate.name,
        channel: emailTemplate.channel,
        status: emailTemplate.status,
        shared: emailTemplate.shared,
        currentVersionId: emailTemplate.currentVersionId,
      })
      .from(emailTemplate)
      .where(eq(emailTemplate.id, templateId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Load the resolved content (subject/body) of a template's current version — for render / "send a test". */
  async getCurrentContent(
    tx: Tx,
    templateId: string,
  ): Promise<{ subject: string | null; body: string } | null> {
    const rows = await tx
      .select({ subject: emailTemplateVersion.subject, body: emailTemplateVersion.body })
      .from(emailTemplate)
      .innerJoin(emailTemplateVersion, eq(emailTemplateVersion.id, emailTemplate.currentVersionId))
      .where(eq(emailTemplate.id, templateId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** The full editor view: metadata + current-version content + version number (LEFT join so a template with
   * no current version still returns). ownerUserId is returned for the caller's D8 visibility/edit decision. */
  async getDetail(tx: Tx, templateId: string): Promise<TemplateDetailRow | null> {
    const rows = await tx
      .select({
        id: emailTemplate.id,
        ownerUserId: emailTemplate.ownerUserId,
        name: emailTemplate.name,
        channel: emailTemplate.channel,
        status: emailTemplate.status,
        shared: emailTemplate.shared,
        subject: emailTemplateVersion.subject,
        body: emailTemplateVersion.body,
        currentVersion: emailTemplateVersion.version,
        updatedAt: emailTemplate.updatedAt,
      })
      .from(emailTemplate)
      .leftJoin(emailTemplateVersion, eq(emailTemplateVersion.id, emailTemplate.currentVersionId))
      .where(eq(emailTemplate.id, templateId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** A template's immutable version history (newest first). Caller has already RLS+D8-scoped the template id. */
  async listVersions(tx: Tx, templateId: string): Promise<TemplateVersionRow[]> {
    return tx
      .select({
        version: emailTemplateVersion.version,
        subject: emailTemplateVersion.subject,
        body: emailTemplateVersion.body,
        createdByUserId: emailTemplateVersion.createdByUserId,
        createdAt: emailTemplateVersion.createdAt,
      })
      .from(emailTemplateVersion)
      .where(eq(emailTemplateVersion.templateId, templateId))
      .orderBy(desc(emailTemplateVersion.version));
  },

  /** Resolve the content of one specific historical version — the source for a restore (clone → new version). */
  async getVersionContent(
    tx: Tx,
    templateId: string,
    version: number,
  ): Promise<{ subject: string | null; body: string } | null> {
    const rows = await tx
      .select({ subject: emailTemplateVersion.subject, body: emailTemplateVersion.body })
      .from(emailTemplateVersion)
      .where(
        and(
          eq(emailTemplateVersion.templateId, templateId),
          eq(emailTemplateVersion.version, version),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async updateMeta(
    tx: Tx,
    templateId: string,
    patch: { name?: string; shared?: boolean; status?: string },
  ): Promise<void> {
    await tx
      .update(emailTemplate)
      .set({ ...patch, updatedAt: sql`now()` })
      .where(eq(emailTemplate.id, templateId));
  },

  /**
   * The owner-scoped template library (D8): the viewer's own templates + workspace-shared ones, active only,
   * joined with their current version so the row carries subject/body. Newest-updated first, KEYSET-paginated
   * on (updated_at, id) so the read is bounded at any table size (the API list contract). RLS-scoped. Returns
   * up to `limit` rows — the caller asks for limit+1 to detect a next page.
   */
  async listForViewer(
    scope: TenantScope,
    viewerUserId: string,
    opts: { limit: number; cursor?: TemplateListCursor; status?: "active" | "archived" },
  ): Promise<TemplateListRow[]> {
    return withTenantTx(scope, (tx) =>
      tx
        .select({
          id: emailTemplate.id,
          name: emailTemplate.name,
          channel: emailTemplate.channel,
          subject: emailTemplateVersion.subject,
          body: emailTemplateVersion.body,
          updatedAt: emailTemplate.updatedAt,
          // Exact keyset key: full-precision text of updated_at (the JS Date the driver returns is ms-truncated).
          cursorKey: sql<string>`${emailTemplate.updatedAt}::text`,
        })
        .from(emailTemplate)
        .innerJoin(
          emailTemplateVersion,
          eq(emailTemplateVersion.id, emailTemplate.currentVersionId),
        )
        .where(
          and(
            eq(emailTemplate.status, opts.status ?? "active"),
            isNotNull(emailTemplate.currentVersionId),
            or(eq(emailTemplate.ownerUserId, viewerUserId), eq(emailTemplate.shared, true)),
            // Keyset: rows strictly "older" than the cursor in (updated_at DESC, id DESC) order. The cursor's
            // updated_at is bound as full-precision text→timestamptz so it compares exactly to the raw column.
            opts.cursor
              ? sql`(${emailTemplate.updatedAt} < ${opts.cursor.updatedAtText}::timestamptz
                    OR (${emailTemplate.updatedAt} = ${opts.cursor.updatedAtText}::timestamptz
                        AND ${emailTemplate.id} < ${opts.cursor.id}))`
              : undefined,
          ),
        )
        .orderBy(desc(emailTemplate.updatedAt), desc(emailTemplate.id))
        .limit(opts.limit),
    );
  },
};
