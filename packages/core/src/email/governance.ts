// governance.ts — platform-staff email governance (M12 P6, 06/11/12; email-planning/13 P6). These run the
// AUDITED cross-tenant path (withPlatformTx → a platform_audit_log row in the same tx) and must only be
// reached behind a verified platform-admin (`pa`) claim. addGlobalSuppression writes a GLOBAL suppression_list
// row (tenant_id/workspace_id NULL) that the UNCHANGED M9 assertNotSuppressed already honours on every reveal
// and send — so one row blocks an address/domain across EVERY tenant. setTenantEmailSendQuota sets a tenant's
// per-tenant send cap. The suppression_list / consent_records tables are reused (D11), never duplicated.

import {
  type PlatformActor,
  sendQuotaRepository,
  suppressionRepository,
  withPlatformTx,
} from "@leadwolf/db";
import { ValidationError } from "@leadwolf/types";
import { blindIndex } from "../import/blindIndex.ts";

export interface AddGlobalSuppressionInput {
  /** Suppress an exact address (HMAC blind-indexed) … */
  email?: string;
  /** … or a whole domain (kept in clear — non-PII). Exactly one of email/domain is required. */
  domain?: string;
  reason?: string;
}

/** Add a GLOBAL (cross-tenant) suppression row. Platform-staff only; audited via withPlatformTx. */
export async function addGlobalSuppression(
  actor: PlatformActor,
  input: AddGlobalSuppressionInput,
): Promise<{ id: string }> {
  const email = input.email?.trim().toLowerCase();
  const domain = input.domain?.trim().toLowerCase();
  if ((email && domain) || (!email && !domain)) {
    throw new ValidationError("Provide exactly one of { email, domain }.");
  }
  return withPlatformTx<{ id: string }>(
    actor,
    "email.global_suppression.add",
    async (tx) => {
      const id = await suppressionRepository.insert(tx, {
        scope: "global",
        tenantId: null,
        workspaceId: null,
        ...(email
          ? { matchType: "email", emailBlindIndex: blindIndex(email) }
          : { matchType: "domain", domain: domain as string }),
        reason: input.reason ?? "global_dnc",
      });
      return { id };
    },
    {
      targetType: "suppression_list",
      metadata: { scope: "global", match: email ? "email" : "domain" },
    },
  );
}

/** Set a tenant's per-tenant email send-quota (null = unlimited). Platform-staff only; audited. */
export async function setTenantEmailSendQuota(
  actor: PlatformActor,
  tenantId: string,
  quota: number | null,
): Promise<void> {
  if (quota !== null && (!Number.isInteger(quota) || quota < 0)) {
    throw new ValidationError("Quota must be a non-negative integer or null.");
  }
  await withPlatformTx(
    actor,
    "email.tenant_quota.set",
    async (tx) => {
      // Owner connection (cross-tenant); RLS is bypassed on the audited platform path.
      await sendQuotaRepository.setQuota(tx, tenantId, quota);
    },
    { targetType: "tenant", targetId: tenantId, tenantId, metadata: { quota } },
  );
}
