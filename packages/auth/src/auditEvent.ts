// auditEvent.ts — the auth-domain audit sink (ADR-0031). recordAuthEvent wraps @leadwolf/db's
// auditRepository.insert in its OWN withTenantTx (the auth domain runs on the bare connection with no
// ambient Tx) and is SWALLOW-ON-FAILURE: auth audit is observational and must NEVER throw into the auth
// flow. Only tenant-resolved events reach here (audit_log.tenant_id is NOT NULL + RLS, 03 §7/§9);
// tenant-less identity events go to platform_audit_log (ADR-0031 §3). Never pass codes/tokens/PII.

import {
  type AuditEntryInput,
  auditRepository,
  recordPlatformEvent,
  withTenantTx,
} from "@leadwolf/db";
import { log } from "./log.ts";

export async function recordAuthEvent(entry: AuditEntryInput): Promise<void> {
  try {
    await withTenantTx(
      {
        tenantId: entry.tenantId,
        ...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
      },
      (tx) => auditRepository.insert(tx, entry),
    );
  } catch (err) {
    // Observational (ADR-0031 §1): a failed audit insert must never break authentication — but it must not
    // be SILENT either, or an audit_log DB/RLS regression is invisible. Log the action, never the entry's
    // identifiers/PII or the error stack.
    log.warn("audit.write.failed", {
      action: entry.action,
      err: err instanceof Error ? err.name : "unknown",
    });
  }
}

// recordPlatformAuthEvent — best-effort sink for the TENANT-LESS auth identity events (ADR-0031 §3): they have
// no single tenant to satisfy audit_log's NOT NULL tenant_id, so they land on platform_audit_log via
// @leadwolf/db's recordPlatformEvent. SWALLOW-ON-FAILURE, like recordAuthEvent — an audit miss must never break
// authentication. entityType is implicitly "user". Never pass codes/tokens/PII in metadata.
type PlatformAuthAction =
  | "login.failure"
  | "mfa.challenge"
  | "mfa.success"
  | "mfa.failure"
  | "password.reset.request"
  | "password.reset.complete"
  | "passkey.register"
  | "passkey.remove";

export async function recordPlatformAuthEvent(entry: {
  action: PlatformAuthAction;
  actorUserId: string;
  ip?: string | null;
  metadata?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await recordPlatformEvent({
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: "user",
      targetId: entry.actorUserId,
      ip: entry.ip ?? null,
      metadata: entry.metadata ?? null,
    });
  } catch (err) {
    log.warn("platform_audit.write.failed", {
      action: entry.action,
      err: err instanceof Error ? err.name : "unknown",
    });
  }
}
