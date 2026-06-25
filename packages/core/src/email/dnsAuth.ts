// dnsAuth.ts — the SPF / DKIM / DMARC verifier for a sending_domain (M12, email-planning/13 P0, 03 §1).
// As of Feb 2024 Gmail/Yahoo make SPF+DKIM+DMARC a HARD requirement for bulk senders (03 §1), so a domain is
// unusable for any send until all three verify. The verification logic is PURE given a DnsResolverPort — the
// real adapter resolves via node:dns; tests inject a static resolver (no network), exactly like the
// EmailVerifierPort / AiPort seams elsewhere in core. core OWNS the port; it never imports a network client
// at module load.

import { Resolver } from "node:dns/promises";

/** The minimal DNS surface the verifier needs. Injected so the check is testable without a network. */
export interface DnsResolverPort {
  /** TXT records for a name, each as the joined record string (node:dns returns string[][]). */
  resolveTxt(name: string): Promise<string[]>;
  /** CNAME targets for a name (for the per-tenant tracking domain, D3). Empty when none. */
  resolveCname(name: string): Promise<string[]>;
}

export interface DomainAuthInputs {
  domain: string;
  /** The DKIM selector to check (e.g. "tp1"); the record at `${selector}._domainkey.${domain}`. */
  dkimSelector?: string | null;
  /** The expected tracking CNAME host (per-tenant, D3); when set, its CNAME target is checked for presence. */
  trackingCname?: string | null;
}

export interface DomainAuthResult {
  spfState: "unverified" | "pass" | "fail";
  dkimState: "unverified" | "pass" | "fail";
  dmarcState: "unverified" | "pass" | "fail";
  trackingCnameState: "unverified" | "pass" | "fail";
}

/** True when a TXT record set contains an SPF record (`v=spf1 …`). */
function hasSpf(txt: string[]): boolean {
  return txt.some((r) => /v=spf1\b/i.test(r));
}

/** True when the DKIM selector record is a public key (`v=DKIM1; … p=<key>`). */
function hasDkim(txt: string[]): boolean {
  return txt.some((r) => /v=DKIM1\b/i.test(r) && /\bp=[A-Za-z0-9+/]/.test(r));
}

/** True when a DMARC record is present (`v=DMARC1; p=…`). Any policy counts as present for P0. */
function hasDmarc(txt: string[]): boolean {
  return txt.some((r) => /v=DMARC1\b/i.test(r));
}

/**
 * Verify SPF/DKIM/DMARC (and the optional tracking CNAME) for a domain. Each lookup independently maps to
 * pass/fail; a resolution error for a record means `fail` (the record is not provably present), never a
 * throw — a missing record must not crash verification. A missing DKIM selector or tracking CNAME stays
 * `unverified` (nothing to check yet) rather than `fail`.
 */
export async function verifyDomainAuth(
  resolver: DnsResolverPort,
  input: DomainAuthInputs,
): Promise<DomainAuthResult> {
  const { domain } = input;
  type Flag = "unverified" | "pass" | "fail";

  const spfState: Flag = await resolver
    .resolveTxt(domain)
    .then((txt): Flag => (hasSpf(txt) ? "pass" : "fail"))
    .catch((): Flag => "fail");

  const dmarcState: Flag = await resolver
    .resolveTxt(`_dmarc.${domain}`)
    .then((txt): Flag => (hasDmarc(txt) ? "pass" : "fail"))
    .catch((): Flag => "fail");

  const dkimState: Flag = input.dkimSelector
    ? await resolver
        .resolveTxt(`${input.dkimSelector}._domainkey.${domain}`)
        .then((txt): Flag => (hasDkim(txt) ? "pass" : "fail"))
        .catch((): Flag => "fail")
    : "unverified";

  const trackingCnameState: Flag = input.trackingCname
    ? await resolver
        .resolveCname(input.trackingCname)
        .then((targets): Flag => (targets.length > 0 ? "pass" : "fail"))
        .catch((): Flag => "fail")
    : "unverified";

  return { spfState, dkimState, dmarcState, trackingCnameState };
}

/** The production resolver: node:dns over the system resolvers. TXT records are joined per RFC chunking. */
export const nodeDnsResolver: DnsResolverPort = {
  async resolveTxt(name: string): Promise<string[]> {
    const resolver = new Resolver();
    const records = await resolver.resolveTxt(name);
    return records.map((chunks) => chunks.join(""));
  },
  async resolveCname(name: string): Promise<string[]> {
    const resolver = new Resolver();
    return resolver.resolveCname(name);
  },
};
