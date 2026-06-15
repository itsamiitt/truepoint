// auditEvent.ts — the auth-domain audit sink (ADR-0031). recordAuthEvent wraps @leadwolf/db's
// auditRepository.insert in its OWN withTenantTx (the auth domain runs on the bare connection with no
// ambient Tx) and is SWALLOW-ON-FAILURE: auth audit is observational and must NEVER throw into the auth
// flow. Only tenant-resolved events reach here (audit_log.tenant_id is NOT NULL + RLS, 03 §7/§9);
// tenant-less identity events go to platform_audit_log (ADR-0031 §3). Never pass codes/tokens/PII.

import { type AuditEntryInput, auditRepository, withTenantTx } from "@leadwolf/db";

export async function recordAuthEvent(entry: AuditEntryInput): Promise<void> {
  try {
    await withTenantTx(
      {
        tenantId: entry.tenantId,
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      },
      (tx) => auditRepository.insert(tx, entry),
    );
  } catch {
    // Observational (ADR-0031 §1): a failed audit insert must never break authentication.
  }
}
