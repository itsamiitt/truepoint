// consent.ts — record + withdraw lawful basis (08 §2). A withdrawal (GDPR objection / CCPA opt-out)
// marks every active basis withdrawn AND auto-inserts a GLOBAL suppression row — gating reveals and
// sends everywhere — via the privileged path (global scope is platform-managed; the app role may only
// write tenant/workspace rows).

import {
  type ConsentInsert,
  type TenantScope,
  consentRepository,
  dsarFanoutRepository,
  revealRepository,
  withPrivilegedTx,
  withTenantTx,
} from "@leadwolf/db";
import { NotFoundError } from "@leadwolf/types";
import { writeAudit } from "./writeAudit.ts";

export async function recordConsent(
  scope: TenantScope & { workspaceId: string },
  input: Omit<ConsentInsert, "tenantId" | "workspaceId">,
): Promise<string> {
  return withTenantTx(scope, async (tx) => {
    const id = await consentRepository.record(tx, {
      ...input,
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
    });
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: input.recordedByUserId ?? null,
      action: "consent.record",
      entityType: "contact",
      entityId: input.contactId,
      metadata: { lawfulBasis: input.lawfulBasis, jurisdiction: input.jurisdiction },
    });
    return id;
  });
}

export interface WithdrawResult {
  withdrawn: number;
  globallySuppressed: boolean;
}

export async function withdrawConsent(
  scope: TenantScope & { workspaceId: string },
  contactId: string,
  actorUserId?: string | null,
): Promise<WithdrawResult> {
  // 1) Withdraw within the workspace scope (app role).
  const { withdrawn, emailBlindIndex } = await withTenantTx(scope, async (tx) => {
    const contact = await revealRepository.getContactForReveal(tx, contactId);
    if (!contact) throw new NotFoundError("Contact not found in this workspace.");
    const count = await consentRepository.withdrawForContact(tx, contactId);
    await writeAudit(tx, {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      actorUserId: actorUserId ?? null,
      action: "consent.withdraw",
      entityType: "contact",
      entityId: contactId,
      metadata: { withdrawn: count },
    });
    return { withdrawn: count, emailBlindIndex: contact.emailBlindIndex };
  });

  // 2) Objection ⇒ GLOBAL suppression (08 §2) — privileged scope, in its own audited tx.
  let globallySuppressed = false;
  if (emailBlindIndex) {
    await withPrivilegedTx(async (tx) => {
      await dsarFanoutRepository.addGlobalSuppression(tx, emailBlindIndex, "consent_withdrawn");
      await writeAudit(tx, {
        tenantId: scope.tenantId,
        workspaceId: scope.workspaceId,
        actorUserId: actorUserId ?? null,
        action: "suppression.add",
        entityType: "suppression_list",
        entityId: null,
        metadata: { scope: "global", reason: "consent_withdrawn", contactId },
      });
    });
    globallySuppressed = true;
  }
  return { withdrawn, globallySuppressed };
}
