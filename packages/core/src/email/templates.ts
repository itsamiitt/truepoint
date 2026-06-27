// templates.ts — the email-template domain logic (M12 P2, 01, 09; email-planning/13 P2). Create/update/list
// versioned, owner-scoped (D8) templates. A content change appends an immutable email_template_version and
// repoints current_version_id; metadata (name/shared/archive) is a plain update. Only the OWNER may edit,
// share, or archive a template (D8) — enforced here, in-tx, alongside the RLS workspace scope. Every mutation
// audits (template.create / template.update — the closed 08 §5 enum already carries these).

import {
  type TemplateListCursor,
  type TenantScope,
  emailTemplateRepository,
  withTenantTx,
} from "@leadwolf/db";
import { ForbiddenError, NotFoundError, ValidationError } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";
import { extractVariables, renderTemplate } from "./renderTemplate.ts";

/** The canonical merge-field vocabulary the editor/preview exposes (mirrors apps/web MERGE_FIELDS). Used as the
 * render `allowedKeys` whitelist so an unknown / attacker-influenced token falls back instead of resolving. */
export const TEMPLATE_MERGE_FIELDS = [
  "first_name",
  "last_name",
  "job_title",
  "company",
  "sender_name",
] as const;
const MERGE_FIELD_SET: ReadonlySet<string> = new Set(TEMPLATE_MERGE_FIELDS);

/** Placeholder values for a preview when the caller supplies no sample — never real contact PII. */
const PREVIEW_SAMPLE: Record<string, string> = {
  first_name: "Alex",
  last_name: "Rivera",
  job_title: "VP of Sales",
  company: "Northwind",
  sender_name: "You",
};

// Opaque keyset cursor = base64url("<updated_at::text>|<id>"). The "|" separator can't occur in a timestamp
// text (digits/-/:/./+/space) or a uuid (hex/-), so the split is unambiguous. A malformed cursor is a client
// error (400), never a silent reset.
const CURSOR_SEP = "|";
const CURSOR_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// The PG `timestamptz::text` form we issue: `YYYY-MM-DD HH:MM:SS[.ffffff][±HH[:MM]]`.
const CURSOR_TS_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}(:\d{2})?)?$/;
// Exported for unit tests (not re-exported from the package index — internal pagination detail).
export function encodeCursor(cursorKey: string, id: string): string {
  return Buffer.from(`${cursorKey}${CURSOR_SEP}${id}`, "utf8").toString("base64url");
}
export function decodeCursor(raw: string): TemplateListCursor {
  // base64url decoding is lenient (never throws — it drops out-of-alphabet bytes), so we validate the decoded
  // CONTENT, not just the structure: both halves are bound into the keyset SQL (`::timestamptz` / a uuid
  // comparison), so a decodable-but-garbage cursor must be rejected HERE as a 4xx, never reach Postgres and
  // surface as a 500. The cursor is server-issued + opaque; any value that fails these shapes is forged/corrupt.
  const decoded = Buffer.from(raw, "base64url").toString("utf8");
  const sep = decoded.indexOf(CURSOR_SEP);
  if (sep < 0) throw new ValidationError("Invalid pagination cursor.");
  const updatedAtText = decoded.slice(0, sep);
  const id = decoded.slice(sep + 1);
  if (!CURSOR_TS_RE.test(updatedAtText) || !CURSOR_UUID_RE.test(id)) {
    throw new ValidationError("Invalid pagination cursor.");
  }
  return { updatedAtText, id };
}

export interface CreateTemplateInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  name: string;
  channel?: "email" | "linkedin";
  subject?: string | null;
  body: string;
  shared?: boolean;
}

export async function createTemplate(input: CreateTemplateInput): Promise<{ id: string }> {
  return withTenantTx<{ id: string }>(input.scope, async (tx) => {
    const templateId = await emailTemplateRepository.insertTemplate(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      ownerUserId: input.userId,
      name: input.name,
      channel: input.channel ?? "email",
    });
    const versionId = await emailTemplateRepository.insertVersion(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      templateId,
      version: 1,
      subject: input.subject ?? null,
      body: input.body,
      createdByUserId: input.userId,
    });
    await emailTemplateRepository.setCurrentVersion(tx, templateId, versionId);
    if (input.shared) await emailTemplateRepository.updateMeta(tx, templateId, { shared: true });
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "template.create",
      entityType: "email_template",
      entityId: templateId,
      metadata: { name: input.name, channel: input.channel ?? "email" },
    });
    return { id: templateId };
  });
}

export interface UpdateTemplateInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  templateId: string;
  /** A content change appends a new immutable version (requires the full subject+body). */
  content?: { subject: string | null; body: string };
  name?: string;
  shared?: boolean;
  /** "archived" hides the template from the library; "active" restores it. */
  status?: "active" | "archived";
}

export async function updateTemplate(
  input: UpdateTemplateInput,
): Promise<{ version: number | null }> {
  return withTenantTx<{ version: number | null }>(input.scope, async (tx) => {
    const template = await emailTemplateRepository.getById(tx, input.templateId);
    if (!template) throw new NotFoundError("Template not found in this workspace.");
    // D8: only the owner may edit/share/archive a template. Stay IDOR-consistent with getTemplate — a private
    // template a non-owner can't even see returns 404 (indistinguishable from absent); a shared one they CAN
    // see but don't own returns 403 ("you're not the owner"), since its existence is not secret.
    if (template.ownerUserId !== input.userId) {
      if (!template.shared) throw new NotFoundError("Template not found in this workspace.");
      throw new ForbiddenError("not_owner", "Only the template owner can edit it.");
    }

    let newVersion: number | null = null;
    if (input.content) {
      newVersion = await emailTemplateRepository.nextVersion(tx, input.templateId);
      const versionId = await emailTemplateRepository.insertVersion(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        templateId: input.templateId,
        version: newVersion,
        subject: input.content.subject,
        body: input.content.body,
        createdByUserId: input.userId,
      });
      await emailTemplateRepository.setCurrentVersion(tx, input.templateId, versionId);
    }

    const meta: { name?: string; shared?: boolean; status?: string } = {};
    if (input.name !== undefined) meta.name = input.name;
    if (input.shared !== undefined) meta.shared = input.shared;
    if (input.status !== undefined) meta.status = input.status;
    if (Object.keys(meta).length > 0)
      await emailTemplateRepository.updateMeta(tx, input.templateId, meta);

    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "template.update",
      entityType: "email_template",
      entityId: input.templateId,
      metadata: { version: newVersion, ...meta },
    });
    return { version: newVersion };
  });
}

export interface TemplateSummary {
  id: string;
  name: string;
  channel: string;
  subject: string | null;
  body: string;
  updatedAt: string;
}

/**
 * The owner-scoped library (D8): the viewer's own + workspace-shared active templates, with their content.
 * KEYSET-paginated (bounded read at any size) — pass the prior page's `nextCursor` to fetch the next page.
 */
export async function listTemplates(
  scope: TenantScope & { workspaceId: string },
  userId: string,
  opts: { limit?: number; cursor?: string; status?: "active" | "archived" } = {},
): Promise<{ templates: TemplateSummary[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : undefined;
  // Fetch one extra to know whether a further page exists without a second COUNT query.
  const rows = await emailTemplateRepository.listForViewer(scope, userId, {
    limit: limit + 1,
    cursor,
    status: opts.status ?? "active",
  });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor = rows.length > limit && last ? encodeCursor(last.cursorKey, last.id) : null;
  return {
    templates: page.map((r) => ({
      id: r.id,
      name: r.name,
      channel: r.channel,
      subject: r.subject,
      body: r.body,
      updatedAt: r.updatedAt.toISOString(),
    })),
    nextCursor,
  };
}

export interface TemplateDetail {
  id: string;
  name: string;
  channel: string;
  status: string;
  shared: boolean;
  subject: string | null;
  body: string;
  currentVersion: number | null;
  updatedAt: string;
  /** Server-computed D8 gate: true only for the owner (the boundary is the server, not this flag). */
  canEdit: boolean;
}

/**
 * One template's full editor view. Visible to its OWNER or to anyone if it's workspace-shared (D8); a template
 * that exists in the workspace but isn't visible to this viewer returns 404 — indistinguishable from "absent"
 * so ids can't be probed (IDOR). RLS already excludes other workspaces.
 */
export async function getTemplate(
  scope: TenantScope & { workspaceId: string },
  userId: string,
  templateId: string,
): Promise<TemplateDetail> {
  return withTenantTx(scope, async (tx) => {
    const d = await emailTemplateRepository.getDetail(tx, templateId);
    if (!d || (d.ownerUserId !== userId && !d.shared)) {
      throw new NotFoundError("Template not found in this workspace.");
    }
    return {
      id: d.id,
      name: d.name,
      channel: d.channel,
      status: d.status,
      shared: d.shared,
      subject: d.subject,
      body: d.body ?? "",
      currentVersion: d.currentVersion,
      updatedAt: d.updatedAt.toISOString(),
      canEdit: d.ownerUserId === userId,
    };
  });
}

export interface TemplateVersion {
  version: number;
  subject: string | null;
  body: string;
  createdByUserId: string | null;
  createdAt: string;
}

/** A template's immutable version history (newest first). Same owner-or-shared visibility as getTemplate (D8). */
export async function listTemplateVersions(
  scope: TenantScope & { workspaceId: string },
  userId: string,
  templateId: string,
): Promise<TemplateVersion[]> {
  return withTenantTx(scope, async (tx) => {
    const template = await emailTemplateRepository.getById(tx, templateId);
    if (!template || (template.ownerUserId !== userId && !template.shared)) {
      throw new NotFoundError("Template not found in this workspace.");
    }
    const versions = await emailTemplateRepository.listVersions(tx, templateId);
    return versions.map((v) => ({
      version: v.version,
      subject: v.subject,
      body: v.body,
      createdByUserId: v.createdByUserId,
      createdAt: v.createdAt.toISOString(),
    }));
  });
}

export interface PreviewTemplateInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  templateId: string;
  /** Optional unsaved draft to preview instead of the stored current version (the editor's live preview). */
  draft?: { subject: string | null; body: string };
  /** Optional sample merge values (capped + allowlisted upstream); placeholders fill the rest. */
  sample?: Record<string, string>;
}

/**
 * Render a template's current content (or an unsaved draft) with sample merge data — READ-ONLY, no audit. The
 * render is the security boundary: single-pass, values HTML-escaped (body) and allowlisted to the canonical
 * merge fields, so an unknown / attacker-influenced token can't resolve or inject. Visible to owner-or-shared.
 */
export async function previewTemplate(
  input: PreviewTemplateInput,
): Promise<{ subject: string | null; body: string; fields: string[] }> {
  return withTenantTx(input.scope, async (tx) => {
    const template = await emailTemplateRepository.getById(tx, input.templateId);
    if (!template || (template.ownerUserId !== input.userId && !template.shared)) {
      throw new NotFoundError("Template not found in this workspace.");
    }
    let subject: string | null;
    let body: string;
    if (input.draft) {
      subject = input.draft.subject;
      body = input.draft.body;
    } else {
      const content = await emailTemplateRepository.getCurrentContent(tx, input.templateId);
      if (!content) throw new NotFoundError("Template has no content to preview.");
      subject = content.subject;
      body = content.body;
    }
    const sample = { ...PREVIEW_SAMPLE, ...(input.sample ?? {}) };
    const renderedSubject =
      subject == null
        ? null
        : renderTemplate(subject, sample, { allowedKeys: MERGE_FIELD_SET, escapeValues: false });
    const renderedBody = renderTemplate(body, sample, {
      allowedKeys: MERGE_FIELD_SET,
      escapeValues: true,
    });
    const fields = [...new Set([...extractVariables(subject ?? ""), ...extractVariables(body)])];
    return { subject: renderedSubject, body: renderedBody, fields };
  });
}

export interface RestoreVersionInput {
  scope: TenantScope & { workspaceId: string };
  userId: string;
  templateId: string;
  version: number;
}

/**
 * Restore version N by APPENDING a new version that clones N's content (versions are immutable — never mutated
 * or deleted — so history is preserved). OWNER-only (D8), like any other content edit; audits template.update.
 */
export async function restoreVersion(input: RestoreVersionInput): Promise<{ version: number }> {
  return withTenantTx(input.scope, async (tx) => {
    const template = await emailTemplateRepository.getById(tx, input.templateId);
    if (!template) throw new NotFoundError("Template not found in this workspace.");
    // D8 + IDOR-consistent (see updateTemplate): invisible private → 404, visible shared (not yours) → 403.
    if (template.ownerUserId !== input.userId) {
      if (!template.shared) throw new NotFoundError("Template not found in this workspace.");
      throw new ForbiddenError("not_owner", "Only the template owner can restore a version.");
    }
    const content = await emailTemplateRepository.getVersionContent(
      tx,
      input.templateId,
      input.version,
    );
    if (!content) throw new NotFoundError("That version does not exist for this template.");
    const newVersion = await emailTemplateRepository.nextVersion(tx, input.templateId);
    const versionId = await emailTemplateRepository.insertVersion(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      templateId: input.templateId,
      version: newVersion,
      subject: content.subject,
      body: content.body,
      createdByUserId: input.userId,
    });
    await emailTemplateRepository.setCurrentVersion(tx, input.templateId, versionId);
    await writeAudit(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      actorUserId: input.userId,
      action: "template.update",
      entityType: "email_template",
      entityId: input.templateId,
      metadata: { restoredFrom: input.version, version: newVersion },
    });
    return { version: newVersion };
  });
}
