// sendingDomainRepository.ts — data access for sending_domain (M12 email, email-planning/13 P0, 03/07).
// TENANT-scoped (a sending domain is a tenant asset shared across its workspaces): the scoped reads run with
// only the tenant GUC set. A domain is unusable for sending until status='verified' (the P1 send path
// resolves a verified domain or refuses); the DNS-auth verifier (core/email/dnsAuth) flips spf/dkim/dmarc
// state and promotes status. Mirrors the outreachLogRepository tx-aware + scope-aware shape.

import { and, desc, eq, sql } from "drizzle-orm";
import { type TenantScope, type Tx, withTenantTx } from "../client.ts";
import { sendingDomain } from "../schema/email.ts";

export interface SendingDomainInsert {
  tenantId: string;
  domain: string;
  region?: string;
  dkimSelector?: string | null;
  dkimPublicKey?: string | null;
  trackingCname?: string | null;
}

export interface SendingDomainRecord {
  id: string;
  domain: string;
  status: string;
  spfState: string;
  dkimState: string;
  dmarcState: string;
  trackingCname: string | null;
  trackingCnameState: string;
  region: string;
  verifiedAt: Date | null;
}

/** The DNS-auth result the verifier writes back (core/email/dnsAuth → here). */
export interface DomainAuthState {
  spfState: "unverified" | "pass" | "fail";
  dkimState: "unverified" | "pass" | "fail";
  dmarcState: "unverified" | "pass" | "fail";
  trackingCnameState?: "unverified" | "pass" | "fail";
}

const columns = {
  id: sendingDomain.id,
  domain: sendingDomain.domain,
  status: sendingDomain.status,
  spfState: sendingDomain.spfState,
  dkimState: sendingDomain.dkimState,
  dmarcState: sendingDomain.dmarcState,
  trackingCname: sendingDomain.trackingCname,
  trackingCnameState: sendingDomain.trackingCnameState,
  region: sendingDomain.region,
  verifiedAt: sendingDomain.verifiedAt,
};

export const sendingDomainRepository = {
  /** Create a pending sending domain. The global UNIQUE(domain) (D2) makes a cross-tenant claim a conflict. */
  async insert(tx: Tx, row: SendingDomainInsert): Promise<string> {
    const inserted = await tx
      .insert(sendingDomain)
      .values({
        tenantId: row.tenantId,
        domain: row.domain,
        region: row.region ?? "US",
        dkimSelector: row.dkimSelector ?? null,
        dkimPublicKey: row.dkimPublicKey ?? null,
        trackingCname: row.trackingCname ?? null,
      })
      .returning({ id: sendingDomain.id });
    return inserted[0]!.id;
  },

  async getById(tx: Tx, domainId: string): Promise<SendingDomainRecord | null> {
    const rows = await tx
      .select(columns)
      .from(sendingDomain)
      .where(eq(sendingDomain.id, domainId))
      .limit(1);
    return rows[0] ?? null;
  },

  /** Newest-first list for the tenant (the Domains admin/settings read). RLS-scoped. */
  async listByTenant(scope: TenantScope): Promise<SendingDomainRecord[]> {
    return withTenantTx(scope, (tx) =>
      tx.select(columns).from(sendingDomain).orderBy(desc(sendingDomain.createdAt)),
    );
  },

  /**
   * Write back the DNS-auth result and promote status: 'verified' only when SPF+DKIM+DMARC all pass
   * (the hard Gmail/Yahoo gate, 03 §1); otherwise 'failed'. Verified domains stamp verified_at.
   */
  async applyAuthState(tx: Tx, domainId: string, state: DomainAuthState): Promise<void> {
    const allPass =
      state.spfState === "pass" && state.dkimState === "pass" && state.dmarcState === "pass";
    await tx
      .update(sendingDomain)
      .set({
        spfState: state.spfState,
        dkimState: state.dkimState,
        dmarcState: state.dmarcState,
        ...(state.trackingCnameState ? { trackingCnameState: state.trackingCnameState } : {}),
        status: allPass ? "verified" : "failed",
        verifiedAt: allPass ? sql`now()` : null,
      })
      .where(eq(sendingDomain.id, domainId));
  },

  /** Resolve a tenant's VERIFIED domain by name — the send-path identity check (P1). Null if absent/unverified. */
  async findVerified(tx: Tx, domain: string): Promise<SendingDomainRecord | null> {
    const rows = await tx
      .select(columns)
      .from(sendingDomain)
      .where(and(eq(sendingDomain.domain, domain), eq(sendingDomain.status, "verified")))
      .limit(1);
    return rows[0] ?? null;
  },
};
