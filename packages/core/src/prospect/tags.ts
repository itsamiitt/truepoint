// tags.ts — domain logic for the record-customization tag layer (ADR-0028, G-REV-6): create / rename-or-
// recolor / delete a workspace tag, and assign / unassign a tag to a record. Each mutation runs inside one
// withTenantTx so RLS scopes it to the caller's workspace. The duplicate-name rule (case-insensitive,
// per-workspace) is enforced here and surfaced as a 409 (TagNameConflictError) — the unique index is the
// backstop. NOTE: tag mutations are AUDIT-FREE for now (the 08 §5 closed audit enum has no tag.* actions);
// follow-up to add tag.create/update/delete/assign once the enum + coverage test are extended.

import { type TenantScope, tagRepository, withTenantTx } from "@leadwolf/db";
import { AppError, NotFoundError, type TagColor, type TaggableEntity } from "@leadwolf/types";

type WorkspaceScope = TenantScope & { workspaceId: string };

/** A duplicate tag name in the workspace (case-insensitive) → 409. The built-in ConflictError's codes are
 *  auth-specific (email_taken/username_taken), so the tag domain ships its own 409 with a tag-specific code
 *  the API/UI can branch on. The unique index on lower(name) is the backstop under the race. */
export class TagNameConflictError extends AppError {
  constructor(name: string) {
    super({
      status: 409,
      code: "tag_name_taken",
      title: "Tag name already in use",
      detail: `A tag named "${name}" already exists in this workspace.`,
    });
  }
}

/** True for a Postgres unique-violation (SQLSTATE 23505) on the per-workspace tag-name index — the race
 *  backstop when two concurrent creates/renames both pass existsByName before either commits. */
function isTagNameUniqueViolation(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    (e as { code?: string }).code === "23505" &&
    String((e as { constraint_name?: string }).constraint_name ?? "").includes("uniq_tags_ws_name")
  );
}

export interface CreateTagInput {
  scope: WorkspaceScope;
  name: string;
  color: TagColor;
}

/** Create a workspace tag. Throws TagNameConflictError (409) if the name already exists (case-insensitive). */
export async function createTag(input: CreateTagInput): Promise<{ id: string }> {
  const name = input.name.trim();
  return withTenantTx<{ id: string }>(input.scope, async (tx) => {
    if (await tagRepository.existsByName(tx, input.scope.workspaceId, name)) {
      throw new TagNameConflictError(name);
    }
    try {
      const id = await tagRepository.insert(tx, {
        tenantId: input.scope.tenantId,
        workspaceId: input.scope.workspaceId,
        name,
        color: input.color,
      });
      return { id };
    } catch (e) {
      // Lost the check→insert race against a concurrent create — surface the same 409, not a generic 500.
      if (isTagNameUniqueViolation(e)) throw new TagNameConflictError(name);
      throw e;
    }
  });
}

export interface UpdateTagInput {
  scope: WorkspaceScope;
  tagId: string;
  name?: string;
  color?: TagColor;
}

/** Rename and/or recolor a tag. Renaming to an existing name (case-insensitive, other than itself) → 409. */
export async function updateTag(input: UpdateTagInput): Promise<void> {
  const name = input.name?.trim();
  return withTenantTx(input.scope, async (tx) => {
    const existing = await tagRepository.findById(tx, input.tagId);
    if (!existing) throw new NotFoundError("Tag not found in this workspace.");
    if (name && name.toLowerCase() !== existing.name.toLowerCase()) {
      if (await tagRepository.existsByName(tx, input.scope.workspaceId, name)) {
        throw new TagNameConflictError(name);
      }
    }
    try {
      await tagRepository.update(tx, input.tagId, { name, color: input.color });
    } catch (e) {
      if (name && isTagNameUniqueViolation(e)) throw new TagNameConflictError(name);
      throw e;
    }
  });
}

/** Delete a tag (its record_tags assignments cascade). Idempotent: deleting an absent tag is a no-op. */
export async function deleteTag(scope: WorkspaceScope, tagId: string): Promise<void> {
  return withTenantTx(scope, (tx) => tagRepository.remove(tx, tagId));
}

export interface AssignTagInput {
  scope: WorkspaceScope;
  tagId: string;
  entity: TaggableEntity;
  recordId: string;
}

/**
 * Attach a tag to a record (idempotent). Throws 404 if the tag OR the target record isn't in the caller's
 * workspace — record_tags has no FK to contacts/accounts, so without this check a workspace could create a
 * mapping pointing at a foreign/non-existent record id (the RLS WITH CHECK passes because the row is stamped
 * with the caller's own workspace_id). Both look-ups run under the same RLS-scoped tx.
 */
export async function assignTag(input: AssignTagInput): Promise<void> {
  return withTenantTx(input.scope, async (tx) => {
    const tag = await tagRepository.findById(tx, input.tagId);
    if (!tag) throw new NotFoundError("Tag not found in this workspace.");
    if (!(await tagRepository.recordExists(tx, input.entity, input.recordId))) {
      throw new NotFoundError("Record not found in this workspace.");
    }
    await tagRepository.assign(tx, {
      tenantId: input.scope.tenantId,
      workspaceId: input.scope.workspaceId,
      tagId: input.tagId,
      entity: input.entity,
      recordId: input.recordId,
    });
  });
}

/** Detach a tag from a record. A no-op when the link is absent (or belongs to another workspace). */
export async function unassignTag(input: AssignTagInput): Promise<void> {
  return withTenantTx(input.scope, (tx) =>
    tagRepository.unassign(tx, input.tagId, input.entity, input.recordId),
  );
}
