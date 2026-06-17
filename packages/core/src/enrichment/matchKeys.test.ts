// matchKeys.test.ts — the normalizers must be deterministic and resilient to dirty, sparse rows. We cover
// PSL domain extraction (incl. multi-part eTLDs), email plus-addressing/case, E.164 happy + invalid paths,
// name canonicalization (accents/case/punctuation), and buildMatchKeys composition + method mapping.

import { describe, expect, test } from "bun:test";
import { blindIndex } from "../import/blindIndex.ts";
import { normalizeEmailForIndex } from "../import/normalize.ts";
import {
  buildMatchKeys,
  canonicalName,
  linkedinPublicId,
  registrableDomain,
  toE164,
} from "./matchKeys.ts";

describe("registrableDomain", () => {
  test("extracts eTLD+1 from an email, dropping the subdomain", () => {
    expect(registrableDomain("john@mail.corp.co.uk")).toBe("corp.co.uk");
    expect(registrableDomain("Jane@Sales.ACME.com")).toBe("acme.com");
  });

  test("handles multi-part public suffixes", () => {
    expect(registrableDomain("https://shop.example.co.uk/path")).toBe("example.co.uk");
    expect(registrableDomain("deep.sub.team.example.com.au")).toBe("example.com.au");
    // allowPrivateDomains:false → ICANN-only suffixes, so github.io itself is the registrable domain.
    expect(registrableDomain("a.b.c.github.io")).toBe("github.io");
  });

  test("strips scheme/path/www from a raw URL or domain", () => {
    expect(registrableDomain("https://www.acme.com/careers")).toBe("acme.com");
    expect(registrableDomain("ACME.COM")).toBe("acme.com");
  });

  test("returns undefined for empty, hostless, or suffix-only input", () => {
    expect(registrableDomain("")).toBeUndefined();
    expect(registrableDomain(null)).toBeUndefined();
    expect(registrableDomain("localhost")).toBeUndefined();
    expect(registrableDomain("co.uk")).toBeUndefined();
  });
});

describe("toE164", () => {
  test("normalizes an already-international number", () => {
    expect(toE164("+1 (415) 555-2671")).toBe("+14155552671");
    expect(toE164("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("uses defaultRegion for a national-format number", () => {
    expect(toE164("(415) 555-2671", "US")).toBe("+14155552671");
    expect(toE164("020 7946 0958", "GB")).toBe("+442079460958");
  });

  test("returns null for invalid or empty input", () => {
    expect(toE164("")).toBeNull();
    expect(toE164(null)).toBeNull();
    expect(toE164("12345")).toBeNull();
    expect(toE164("not a phone")).toBeNull();
    expect(toE164("(415) 555-2671")).toBeNull(); // national format, no region → unparseable
  });
});

describe("canonicalName", () => {
  test("lowercases, strips accents and punctuation, collapses whitespace", () => {
    expect(canonicalName({ fullName: "  José  O'Neil-Smith " })).toEqual({
      canonical: "jose o neil smith",
      tokens: ["jose", "o", "neil", "smith"],
    });
  });

  test("joins first + last when no fullName", () => {
    expect(canonicalName({ firstName: "Renée", lastName: "MÜLLER" })).toEqual({
      canonical: "renee muller",
      tokens: ["renee", "muller"],
    });
  });

  test("prefers fullName over first/last", () => {
    expect(
      canonicalName({ fullName: "Ada Lovelace", firstName: "X", lastName: "Y" })?.canonical,
    ).toBe("ada lovelace");
  });

  test("returns undefined when no name material remains", () => {
    expect(canonicalName({})).toBeUndefined();
    expect(canonicalName({ fullName: "   " })).toBeUndefined();
    expect(canonicalName({ fullName: "!!! ---" })).toBeUndefined();
  });

  test("preserves non-Latin scripts instead of dropping them", () => {
    // Cyrillic + CJK survive the punctuation filter (they previously collapsed to undefined).
    expect(canonicalName({ fullName: "Иван Петров" })).toEqual({
      canonical: "иван петров",
      tokens: ["иван", "петров"],
    });
    expect(canonicalName({ fullName: "李 雷" })).toEqual({
      canonical: "李 雷",
      tokens: ["李", "雷"],
    });
    // NFKD folds decomposable Cyrillic too (й → и), mirroring Latin accent folding — lossy but deterministic.
    expect(canonicalName({ fullName: "Толстой" })?.canonical).toBe("толстои");
  });
});

describe("linkedinPublicId", () => {
  test("extracts the slug from a profile URL and lowercases a bare slug", () => {
    expect(linkedinPublicId("https://www.linkedin.com/in/John-Doe-123/")).toBe("john-doe-123");
    expect(linkedinPublicId("Jane-Smith")).toBe("jane-smith");
  });

  test("returns undefined for empty input", () => {
    expect(linkedinPublicId("")).toBeUndefined();
  });
});

describe("buildMatchKeys", () => {
  test("composes every deterministic + fuzzy key from a full row", () => {
    const keys = buildMatchKeys({
      email: "John.Doe+sales@Mail.ACME.com",
      phone: "+1 415 555 2671",
      fullName: "John Doe",
      linkedinUrl: "https://linkedin.com/in/johndoe",
      companyName: "Acme Inc",
    });

    // deterministic_email: blind index of the plus-stripped, lowercased email.
    expect(keys.emailIndex).toEqual(blindIndex(normalizeEmailForIndex("john.doe@mail.acme.com")));
    // deterministic_domain: eTLD+1 from the email host.
    expect(keys.registrableDomain).toBe("acme.com");
    // deterministic_phone.
    expect(keys.e164Phone).toBe("+14155552671");
    // deterministic_linkedin.
    expect(keys.linkedinPublicId).toBe("johndoe");
    // fuzzy_name_company.
    expect(keys.name).toEqual({ canonical: "john doe", tokens: ["john", "doe"] });
    expect(keys.companyName).toBe("acme inc");
  });

  test("plus-addressing + case fold to the same email index (alias dedup)", () => {
    const a = buildMatchKeys({ email: "Sam+newsletter@Example.com" });
    const b = buildMatchKeys({ email: "sam@example.com" });
    expect(a.emailIndex).toEqual(b.emailIndex);
  });

  test("falls back to companyDomain for the registrable domain when no email", () => {
    const keys = buildMatchKeys({ companyDomain: "https://www.acme.io/about" });
    expect(keys.emailIndex).toBeUndefined();
    expect(keys.registrableDomain).toBe("acme.io");
  });

  test("phone uses the row defaultRegion", () => {
    expect(buildMatchKeys({ phone: "(415) 555-2671", defaultRegion: "US" }).e164Phone).toBe(
      "+14155552671",
    );
  });

  test("a sparse / dirty row yields only the keys it can support", () => {
    const keys = buildMatchKeys({ phone: "nope", companyName: "  " });
    expect(keys.emailIndex).toBeUndefined();
    expect(keys.registrableDomain).toBeUndefined();
    expect(keys.e164Phone).toBeUndefined();
    expect(keys.linkedinPublicId).toBeUndefined();
    expect(keys.name).toBeUndefined();
    expect(keys.companyName).toBeUndefined();
  });

  test("is deterministic: same row → identical keys", () => {
    const row = { email: "a@b.com", phone: "+14155552671", fullName: "A B" };
    expect(buildMatchKeys(row)).toEqual(buildMatchKeys(row));
  });
});
