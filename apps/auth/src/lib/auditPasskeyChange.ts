// auditPasskeyChange.ts — best-effort audit for a passkey credential add/remove (AUTH-024). A login-credential
// change is a security-sensitive account event and belongs in the trail (SOC 2 / DPDP). Mirrors the
// password.reset dual-sink: the tenant audit_log when the user has exactly one tenant, else platform_audit_log
// (audit_log requires a tenant_id). Fully swallow-on-failure — an audit miss must never break the passkey route.
import { clientIpFromHeaders } from "@/lib/clientIp";
import { recordAuthEvent, recordPlatformAuthEvent } from "@leadwolf/auth";
import { tenantMemberRepository } from "@leadwolf/db";
import { headers } from "next/headers";

export async function auditPasskeyChange(
  userId: string,
  action: "passkey.register" | "passkey.remove",
): Promise<void> {
  try {
    const ip = clientIpFromHeaders(await headers());
    const tenants = await tenantMemberRepository.listForUser(userId);
    if (tenants.length === 1 && tenants[0]) {
      await recordAuthEvent({
        tenantId: tenants[0].tenantId,
        actorUserId: userId,
        action,
        entityType: "user",
        entityId: userId,
        metadata: { via: "account_security" },
        ipAddress: ip,
      });
    } else {
      await recordPlatformAuthEvent({
        action,
        actorUserId: userId,
        ip,
        metadata: { via: "account_security" },
      });
    }
  } catch {
    // best-effort: the recorders swallow their own failures, but the tenant lookup / header read could throw.
  }
}
