// dnsAuth.test.ts — the SPF/DKIM/DMARC verifier (M12, email-planning/13 P0, 03 §1). Pure given an injected
// DnsResolverPort, so it runs without a network (no @leadwolf/config / DB import). Proves: all-present →
// all pass; a missing record → that one fails (never throws); a resolver error (NXDOMAIN) → fail; no DKIM
// selector / no tracking CNAME → unverified (nothing to check). This is the verification the hard
// Gmail/Yahoo gate depends on.

import { describe, expect, test } from "bun:test";
import { type DnsResolverPort, verifyDomainAuth } from "./dnsAuth.ts";

/** A static resolver: TXT/CNAME records keyed by name; a missing name rejects like NXDOMAIN. */
function staticResolver(records: {
  txt?: Record<string, string[]>;
  cname?: Record<string, string[]>;
}): DnsResolverPort {
  return {
    async resolveTxt(name: string): Promise<string[]> {
      const hit = records.txt?.[name];
      if (!hit) throw new Error(`ENOTFOUND ${name}`);
      return hit;
    },
    async resolveCname(name: string): Promise<string[]> {
      const hit = records.cname?.[name];
      if (!hit) throw new Error(`ENOTFOUND ${name}`);
      return hit;
    },
  };
}

describe("verifyDomainAuth", () => {
  test("all records present → SPF/DKIM/DMARC all pass", async () => {
    const resolver = staticResolver({
      txt: {
        "mail.acme.com": ["v=spf1 include:amazonses.com -all"],
        "_dmarc.mail.acme.com": ["v=DMARC1; p=reject; rua=mailto:dmarc@acme.com"],
        "tp1._domainkey.mail.acme.com": ["v=DKIM1; k=rsa; p=MIGfMA0GCSqAQ8AMIIBCgK"],
      },
    });
    const result = await verifyDomainAuth(resolver, {
      domain: "mail.acme.com",
      dkimSelector: "tp1",
    });
    expect(result.spfState).toBe("pass");
    expect(result.dkimState).toBe("pass");
    expect(result.dmarcState).toBe("pass");
  });

  test("missing SPF → spf fail, others still evaluated", async () => {
    const resolver = staticResolver({
      txt: {
        "mail.acme.com": ["some-unrelated-txt"],
        "_dmarc.mail.acme.com": ["v=DMARC1; p=none"],
      },
    });
    const result = await verifyDomainAuth(resolver, { domain: "mail.acme.com" });
    expect(result.spfState).toBe("fail");
    expect(result.dmarcState).toBe("pass");
  });

  test("a resolver error (NXDOMAIN) maps to fail, never throws", async () => {
    const resolver = staticResolver({ txt: {} }); // every lookup rejects
    const result = await verifyDomainAuth(resolver, { domain: "nope.example.com" });
    expect(result.spfState).toBe("fail");
    expect(result.dmarcState).toBe("fail");
  });

  test("no DKIM selector and no tracking CNAME → those stay 'unverified'", async () => {
    const resolver = staticResolver({
      txt: {
        "mail.acme.com": ["v=spf1 -all"],
        "_dmarc.mail.acme.com": ["v=DMARC1; p=quarantine"],
      },
    });
    const result = await verifyDomainAuth(resolver, { domain: "mail.acme.com" });
    expect(result.dkimState).toBe("unverified");
    expect(result.trackingCnameState).toBe("unverified");
  });

  test("a DKIM TXT without a public key (p=) does not pass", async () => {
    const resolver = staticResolver({
      txt: {
        "mail.acme.com": ["v=spf1 -all"],
        "_dmarc.mail.acme.com": ["v=DMARC1; p=none"],
        "tp1._domainkey.mail.acme.com": ["v=DKIM1; k=rsa"], // revoked key (no p=)
      },
    });
    const result = await verifyDomainAuth(resolver, {
      domain: "mail.acme.com",
      dkimSelector: "tp1",
    });
    expect(result.dkimState).toBe("fail");
  });

  test("tracking CNAME present → pass", async () => {
    const resolver = staticResolver({
      txt: { "mail.acme.com": ["v=spf1 -all"], "_dmarc.mail.acme.com": ["v=DMARC1; p=none"] },
      cname: { "track.acme.com": ["t.truepoint.in"] },
    });
    const result = await verifyDomainAuth(resolver, {
      domain: "mail.acme.com",
      trackingCname: "track.acme.com",
    });
    expect(result.trackingCnameState).toBe("pass");
  });
});
