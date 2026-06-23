// domainRepository.ts — read/claim/verify a tenant's DNS domains (enterprise IAM, 17 / ADR-0017). The
// `tenant_domains` table is TENANT-scoped (RLS USING tenant_id = GUC, applied in auth.sql / FORCE posture per
// the auth schema), so every operation here runs under withTenantTx as leadwolf_app — a security_admin only
// ever touches their OWN org's domains. The claim + the verify are AUDITED (settings.update on `domain`) in
// the SAME transaction. The identifier-step / pre-tenant domain→tenant routing read lives separately in
// tenantDomainRepository (workspaceRepository.ts) on the global client; this repo is the org-admin surface.
//
// WIRE: actual DNS TXT verification (resolve the dns_txt_record, compare the verification_token) is deferred
// to the verification worker — markVerified here only flips the status once that check has passed.

import { randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { withTenantTx } from "../client.ts";
import { tenantDomains } from "../schema/auth.ts";
import { auditRepository } from "./auditRepository.ts";

export interface DomainRecord {
  id: string;
  domain: string;
  status: string; // pending | verified | failed
  joinPolicy: string; // sso_only | auto_join | request_access
  verifiedAt: Date | null;
}

function toRecord(r: {
  id: string;
  domain: string;
  status: string;
  joinPolicy: string;
  verifiedAt: Date | null;
}): DomainRecord {
  return {
    id: r.id,
    domain: r.domain,
    status: r.status,
    joinPolicy: r.joinPolicy,
    verifiedAt: r.verifiedAt,
  };
}

export const domainRepository = {
  /** Every domain claimed by the tenant, newest first. RLS-scoped read (leadwolf_app under the tenant GUC). */
  async listForTenant(tenantId: string): Promise<DomainRecord[]> {
    return withTenantTx({ tenantId }, async (tx) => {
      const rows = await tx
        .select({
          id: tenantDomains.id,
          domain: tenantDomains.domain,
          status: tenantDomains.status,
          joinPolicy: tenantDomains.joinPolicy,
          verifiedAt: tenantDomains.verifiedAt,
        })
        .from(tenantDomains)
        .where(eq(tenantDomains.tenantId, tenantId))
        .orderBy(desc(tenantDomains.createdAt));
      return rows.map(toRecord);
    });
  },

  /**
   * Claim a domain for the tenant: insert a `pending` row with a freshly generated verification token + the
   * DNS TXT record the org must publish to prove control. Audited (settings.update on `domain`) in the same
   * tx. `domain` is a citext UNIQUE column, so a claim of an already-claimed domain fails at the DB layer.
   */
  async claim(tenantId: string, domain: string, actorUserId: string): Promise<DomainRecord> {
    return withTenantTx({ tenantId }, async (tx) => {
      const verificationToken = randomBytes(16).toString("hex");
      const dnsTxtRecord = `truepoint-verification=${verificationToken}`;
      const [row] = await tx
        .insert(tenantDomains)
        .values({
          tenantId,
          domain,
          status: "pending",
          verificationToken,
          dnsTxtRecord,
        })
        .returning({
          id: tenantDomains.id,
          domain: tenantDomains.domain,
          status: tenantDomains.status,
          joinPolicy: tenantDomains.joinPolicy,
          verifiedAt: tenantDomains.verifiedAt,
        });
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null, // tenant-level identity change
        actorUserId,
        action: "settings.update",
        entityType: "domain",
        entityId: row!.id,
        metadata: { event: "domain.claim", domain, status: "pending" },
      });
      return toRecord(row!);
    });
  },

  /**
   * Mark a tenant's domain verified (status=verified, verifiedAt=now). Audited in the same tx. RLS-scoped, so
   * a domainId from another tenant simply matches no row (the WHERE tenant_id guard is belt-and-braces over
   * the RLS USING clause). WIRE: the actual DNS TXT check runs before this in the verification worker.
   */
  async markVerified(
    tenantId: string,
    domainId: string,
    actorUserId: string,
  ): Promise<DomainRecord | null> {
    return withTenantTx({ tenantId }, async (tx) => {
      const [row] = await tx
        .update(tenantDomains)
        .set({ status: "verified", verifiedAt: new Date() })
        .where(and(eq(tenantDomains.id, domainId), eq(tenantDomains.tenantId, tenantId)))
        .returning({
          id: tenantDomains.id,
          domain: tenantDomains.domain,
          status: tenantDomains.status,
          joinPolicy: tenantDomains.joinPolicy,
          verifiedAt: tenantDomains.verifiedAt,
        });
      if (!row) return null;
      await auditRepository.insert(tx, {
        tenantId,
        workspaceId: null,
        actorUserId,
        action: "settings.update",
        entityType: "domain",
        entityId: row.id,
        metadata: { event: "domain.verify", domain: row.domain, status: "verified" },
      });
      return toRecord(row);
    });
  },
};
