// archiveJunkCaptures.ts — audited cleanup of pre-guard junk capture rows (Layer-0-as-database plan,
// slice 8 [A-03]). Contacts with NO usable person data (no name/title/channel, never revealed) whose only
// provenance is the chrome_extension capture path are the residue of the old unguarded Sales-Nav
// extractor. Soft-archive (deleted_at — reversible), one workspace at a time, always audited, always
// under RLS via withTenantTx. A dry run reports what WOULD be archived and writes nothing.
import { contactRepository, withTenantTx } from "@leadwolf/db";
import { writeAudit } from "../compliance/writeAudit.ts";

export interface ArchiveJunkCapturesInput {
  tenantId: string;
  workspaceId: string;
  actorUserId: string;
  dryRun: boolean;
  limit?: number;
}

export interface ArchiveJunkCapturesResult {
  matched: number;
  archived: number;
  dryRun: boolean;
}

export async function archiveJunkCaptures(
  input: ArchiveJunkCapturesInput,
): Promise<ArchiveJunkCapturesResult> {
  const scope = { tenantId: input.tenantId, workspaceId: input.workspaceId };
  return withTenantTx(scope, async (tx) => {
    const ids = await contactRepository.listJunkCaptureIds(
      tx,
      input.workspaceId,
      input.limit ?? 500,
    );
    if (input.dryRun || ids.length === 0) {
      return { matched: ids.length, archived: 0, dryRun: input.dryRun };
    }
    const archived = await contactRepository.archive(tx, ids);
    await writeAudit(tx, {
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "contact.delete",
      entityType: "contact",
      metadata: { reason: "junk_capture", affected: archived },
    });
    return { matched: ids.length, archived, dryRun: false };
  });
}
