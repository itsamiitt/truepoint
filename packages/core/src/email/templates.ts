// templates.ts — the email-template domain logic (M12 P2, 01, 09; email-planning/13 P2). Create/update/list
// versioned, owner-scoped (D8) templates. A content change appends an immutable email_template_version and
// repoints current_version_id; metadata (name/shared/archive) is a plain update. Only the OWNER may edit,
// share, or archive a template (D8) — enforced here, in-tx, alongside the RLS workspace scope. Every mutation
// audits (template.create / template.update — the closed 08 §5 enum already carries these).

import { type TenantScope, emailTemplateRepository, withTenantTx } from "@leadwolf/db";
import { ForbiddenError, NotFoundError } from "@leadwolf/types";
import { writeAudit } from "../compliance/writeAudit.ts";

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
    // D8: only the owner may edit/share/archive a template.
    if (template.ownerUserId !== input.userId) {
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

/** The owner-scoped library (D8): the viewer's own + workspace-shared active templates, with their content. */
export async function listTemplates(
  scope: TenantScope & { workspaceId: string },
  userId: string,
): Promise<
  Array<{
    id: string;
    name: string;
    channel: string;
    subject: string | null;
    body: string;
    updatedAt: string;
  }>
> {
  const rows = await emailTemplateRepository.listForViewer(scope, userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    channel: r.channel,
    subject: r.subject,
    body: r.body,
    updatedAt: r.updatedAt.toISOString(),
  }));
}
