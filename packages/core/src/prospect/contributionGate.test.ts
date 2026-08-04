import { describe, expect, test } from "bun:test";
import type { NeverShareField } from "@leadwolf/types";
import {
  type ContributionGateInput,
  evaluateContribution,
  mintRestrictions,
} from "./contributionGate.ts";

function gate(over: Partial<ContributionGateInput> = {}): ContributionGateInput {
  return {
    neverShareFields: [],
    excludedDomains: new Set(),
    excludedAccountIds: new Set(),
    excludedContactIds: new Set(),
    ...over,
  };
}

const row = {
  contactId: "c1",
  accountId: "a1",
  registrableDomain: "acme.com",
  emailDomain: "acme.com",
};

describe("evaluateContribution", () => {
  test("a workspace with NO controls set is unaffected — the gate is an opt-OUT", () => {
    // D13. The mint this gates is ADR-0021's identity-only MATCH-AGAINST path, which the repo already treats
    // as the contribute-off state. Default-denying it would stop the dedup spine growing for every existing
    // tenant on migration day, silently, with nobody having asked.
    const v = evaluateContribution(gate(), row);
    expect(v.mayMint).toBe(true);
    expect(v.reason).toBeNull();
  });

  test("reports the NARROWEST rule that fired, not the broadest", () => {
    // An admin auditing "why is this record not shared" needs the rule they wrote. A row covered by all three
    // lists must name the contact-level one.
    const v = evaluateContribution(
      gate({
        excludedContactIds: new Set(["c1"]),
        excludedAccountIds: new Set(["a1"]),
        excludedDomains: new Set(["acme.com"]),
      }),
      row,
    );
    expect(v.reason).toBe("contact_excluded");

    const acct = evaluateContribution(
      gate({ excludedAccountIds: new Set(["a1"]), excludedDomains: new Set(["acme.com"]) }),
      row,
    );
    expect(acct.reason).toBe("account_excluded");
  });

  test("the EMAIL domain is checked even when the row has no account", () => {
    // CRM-synced rows frequently carry no account domain. Excluding acme.com and then contributing the row
    // because accounts.domain happened to be blank is the hole a customer would call a breach.
    const v = evaluateContribution(gate({ excludedDomains: new Set(["acme.com"]) }), {
      contactId: "c2",
      accountId: null,
      registrableDomain: null,
      emailDomain: "acme.com",
    });
    expect(v.mayMint).toBe(false);
    expect(v.reason).toBe("domain_excluded");
  });

  test("domain matching is case-insensitive", () => {
    const v = evaluateContribution(gate({ excludedDomains: new Set(["acme.com"]) }), {
      ...row,
      registrableDomain: "ACME.com",
    });
    expect(v.mayMint).toBe(false);
  });

  test("an allowed row still carries the never-share set", () => {
    const v = evaluateContribution(gate({ neverShareFields: ["email"] }), row);
    expect(v.mayMint).toBe(true);
    expect(v.withheldFields).toEqual(["email"]);
  });

  test("a denied row reports no withheld fields — nothing is shared to withhold from", () => {
    const v = evaluateContribution(
      gate({ excludedContactIds: new Set(["c1"]), neverShareFields: ["email"] }),
      row,
    );
    expect(v.mayMint).toBe(false);
    expect(v.withheldFields).toEqual([]);
  });
});

describe("mintRestrictions", () => {
  test("returns undefined when there is nothing to say", () => {
    // The common case must pass no options at all so the resolver takes its unchanged path.
    expect(mintRestrictions({ mayMint: true, reason: null, withheldFields: [] })).toBeUndefined();
    expect(
      mintRestrictions({ mayMint: false, reason: "domain_excluded", withheldFields: [] }),
    ).toBeUndefined();
  });

  test("withholding the company also withholds the employment edge", () => {
    // An employment edge with no company is not expressible — the mint would fail on a null FK rather than
    // decline politely.
    const r = mintRestrictions({ mayMint: true, reason: null, withheldFields: ["company"] });
    expect(r?.withholdCompany).toBe(true);
    expect(r?.withholdEmployment).toBe(true);
  });

  test("employment can be withheld without withholding the company", () => {
    const r = mintRestrictions({ mayMint: true, reason: null, withheldFields: ["employment"] });
    expect(r?.withholdEmployment).toBe(true);
    expect(r?.withholdCompany).toBeUndefined();
  });

  test("phone maps to nothing — the mint writes no phone today", () => {
    // Accepted in the vocabulary so the rule binds the day phones land, rather than being silently accepted
    // and then silently ignored after the behaviour changes.
    expect(
      mintRestrictions({
        mayMint: true,
        reason: null,
        withheldFields: ["phone" as NeverShareField],
      }),
    ).toBeUndefined();
  });

  test("email and linkedin map to their own flags", () => {
    const r = mintRestrictions({
      mayMint: true,
      reason: null,
      withheldFields: ["email", "linkedin"],
    });
    expect(r?.withholdEmail).toBe(true);
    expect(r?.withholdLinkedin).toBe(true);
  });
});
