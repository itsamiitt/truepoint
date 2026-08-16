// mapLinkedinPayload.test.ts — the pure mapper against fixtures shaped from the recorded `source plan/`
// samples. The load-bearing assertions: the raw-only compliance boundary (pronoun/job_seeker/skills never
// reach the mapped output), revenue unit→minor-unit math, ownership normalization, partial-date precision,
// and by_function-empty tolerance.

import { describe, expect, test } from "bun:test";
import { linkedinApiCompanyPayloadSchema, linkedinApiPersonPayloadSchema } from "@leadwolf/types";
import {
  headcountDeltaPct,
  mapLinkedinCompany,
  mapLinkedinPerson,
  mapOwnershipType,
  revenueDisplay,
  revenueMinor,
} from "./mapLinkedinPayload.ts";

// Shaped from `source plan/truepoint profile Response.txt` (trimmed; same structure).
const PERSON_FIXTURE = {
  schema_version: 1,
  profile_id: "ACwAAAkMo0QBIgbAXuFmUKhDjOGNw2hj0tjFPqg",
  member_id: 151823172,
  public_identifier: "william-gates-cpa-770a1842",
  linkedin_url: "https://www.linkedin.com/in/william-gates-cpa-770a1842",
  first_name: "William",
  last_name: "Gates, CPA",
  full_name: "William Gates, CPA",
  pronoun: null,
  headline: "VP of Finance",
  summary: null,
  location: "Fort Lauderdale, Florida, United States",
  premium: false,
  open_link: false,
  job_seeker: false,
  profile_picture: "https://media.licdn.com/photo.jpg",
  background_picture: null,
  current_position: {
    title: "Senior Director of Accounting",
    company_name: "Vertical Bridge",
    company_id: 9338128,
    is_current: true,
    start_date: "2026-05",
    end_date: null,
  },
  positions: [
    {
      title: "Senior Director of Accounting",
      company_name: "Vertical Bridge",
      company_id: 9338128,
      location: null,
      description: null,
      is_current: true,
      start_date: "2026-05",
      end_date: null,
    },
    {
      title: "VP of Finance",
      company_name: "Sage Dental",
      company_id: 2844769,
      is_current: false,
      start_date: "2025-05",
      end_date: "2026-05",
    },
    {
      title: "Financial Reporting Manager",
      company_name: "Unified Women's Healthcare",
      company_id: 14806044,
      location: "Boca Raton, Florida",
      is_current: false,
      start_date: "2018",
      end_date: "2022-01",
    },
  ],
  educations: [
    {
      school_name: "Florida Atlantic University",
      school_id: 9077,
      degree: "Master of Accounting",
      fields_of_study: ["Accounting"],
      start_date: "2010",
      end_date: "2011",
    },
    {
      school_name: "D.A.V. Public school NH3",
      school_id: null,
      degree: null,
      fields_of_study: [],
      start_date: null,
      end_date: null,
    },
  ],
  skills: ["ASC 606", "Accounting"],
  languages: [{ name: "English", proficiency: "PROFESSIONAL_WORKING" }],
  volunteering: [{ role: "Mentor", organization: "X", cause: "education" }],
  contact: { primary_email: null, emails: [], phones: [] },
};

// Shaped from `source plan/Truepoint company 1.txt` (monthly series trimmed to 4 points).
const COMPANY_FIXTURE = {
  schema_version: 2,
  company_id: 2619,
  entity_urn: "urn:li:fs_salesCompany:2619",
  public_identifier: "antheminc",
  linkedin_url: "https://www.linkedin.com/company/antheminc/",
  sales_navigator_url: "https://www.linkedin.com/sales/company/2619",
  name: "Anthem, Inc.",
  description: "Anthem, Inc. is now Elevance Health.",
  industry: "Hospitals and Health Care",
  type: "Public Company",
  specialties: [],
  website: "www.elevancehealth.com",
  location: "Indianapolis, Indiana, United States",
  headquarters: {
    line1: "220 Virginia Ave",
    line2: null,
    city: "Indianapolis",
    geographic_area: "Indiana",
    postal_code: "46203",
    country: "United States",
  },
  year_founded: null,
  revenue_range: {
    currency: "USD",
    min: { amount: 5, unit: "MILLION" },
    max: { amount: 10, unit: "MILLION" },
  },
  logo: "https://media.licdn.com/logo.jpg",
  background_picture: null,
  employee_count: 18287,
  headcount: {
    total: 18287,
    as_of: "2026-08",
    growth: { one_month: { from: 18282, to: 18287, change: 5, change_pct: 0, direction: "up" } },
    monthly: [
      { month: "2026-05", count: 18262, change: 5, change_pct: 0 },
      { month: "2026-06", count: 18269, change: 7, change_pct: 0 },
      { month: "2026-07", count: 18282, change: 13, change_pct: 0 },
      { month: "2026-08", count: 18287, change: 5, change_pct: 0 },
    ],
    by_function: [],
    changes_by_function: { window: "one_year", growing: [], shrinking: [], flat: [] },
  },
};

describe("mapLinkedinPerson", () => {
  const parsed = linkedinApiPersonPayloadSchema.parse(PERSON_FIXTURE);
  const mapped = mapLinkedinPerson(parsed);

  test("identity spine: slug + urn + member id, as identifier rows too", () => {
    expect(mapped.linkedinPublicId).toBe("william-gates-cpa-770a1842");
    expect(mapped.linkedinMemberUrn).toBe(PERSON_FIXTURE.profile_id);
    expect(mapped.linkedinMemberId).toBe("151823172");
    expect(mapped.identifiers).toEqual([
      { idType: "linkedin_public_id", idValue: "william-gates-cpa-770a1842" },
      { idType: "linkedin_member_urn", idValue: PERSON_FIXTURE.profile_id },
      { idType: "linkedin_member_id", idValue: "151823172" },
    ]);
  });

  test("the raw-only compliance boundary holds: no sensitive field reaches the mapped output", () => {
    const flat = JSON.stringify(mapped);
    expect(mapped.fields).not.toHaveProperty("pronoun");
    expect(mapped.fields).not.toHaveProperty("premium");
    expect(mapped.fields).not.toHaveProperty("jobSeeker");
    expect(mapped.fields).not.toHaveProperty("profilePhotoUrl");
    expect(flat).not.toContain("profile_picture");
    expect(flat).not.toContain("licdn.com/photo");
    expect(flat).not.toContain("ASC 606"); // skills stay raw-only
    expect(flat).not.toContain("PROFESSIONAL_WORKING"); // languages stay raw-only
  });

  test("profile scalars: headline/location land; jobTitle comes from the primary position", () => {
    expect(mapped.fields.headline).toBe("VP of Finance");
    expect(mapped.fields.locationRaw).toBe("Fort Lauderdale, Florida, United States");
    expect(mapped.fields.jobTitle).toBe("Senior Director of Accounting");
    expect(mapped.fields).not.toHaveProperty("summary"); // null in fixture → absent, not ""
  });

  test("positions: partial dates normalize with precision; primary index matches current_position", () => {
    expect(mapped.positions).toHaveLength(3);
    expect(mapped.primaryPositionIndex).toBe(0);
    const current = mapped.positions[0]!;
    expect(current.start).toEqual({ isoDate: "2026-05-01", precision: "month" });
    expect(current.end).toEqual({ isoDate: null, precision: null });
    const yearOnly = mapped.positions[2]!;
    expect(yearOnly.start).toEqual({ isoDate: "2018-01-01", precision: "year" });
    expect(yearOnly.end).toEqual({ isoDate: "2022-01-01", precision: "month" });
    expect(yearOnly.linkedinCompanyId).toBe("14806044");
    expect(yearOnly.companyNameNormalized).toBe("unified women s healthcare");
  });

  test("educations: school id carried; empty fields_of_study → null", () => {
    expect(mapped.educations).toHaveLength(2);
    expect(mapped.educations[0]!.linkedinSchoolId).toBe("9077");
    expect(mapped.educations[0]!.fieldsOfStudy).toEqual(["Accounting"]);
    expect(mapped.educations[1]!.linkedinSchoolId).toBeNull();
    expect(mapped.educations[1]!.fieldsOfStudy).toBeNull();
  });
});

describe("mapLinkedinCompany", () => {
  const parsed = linkedinApiCompanyPayloadSchema.parse(COMPANY_FIXTURE);
  const mapped = mapLinkedinCompany(parsed);

  test("identity: numeric id + slug + website-derived registrable domain", () => {
    expect(mapped.linkedinCompanyId).toBe("2619");
    expect(mapped.linkedinCompanySlug).toBe("antheminc");
    expect(mapped.registrableDomain).toBe("elevancehealth.com");
    expect(mapped.identifiers).toEqual([
      { idType: "linkedin_company_id", idValue: "2619" },
      { idType: "linkedin_company_slug", idValue: "antheminc" },
    ]);
  });

  test("firmographics: ownership normalized, revenue MILLION → minor units, dual display string", () => {
    expect(mapped.fields.ownershipType).toBe("public");
    expect(mapped.fields.revenueCurrency).toBe("USD");
    expect(mapped.fields.revenueMinMinor).toBe(500_000_000);
    expect(mapped.fields.revenueMaxMinor).toBe(1_000_000_000);
    expect(mapped.fields.revenueRange).toBe("$5M–$10M");
    expect(mapped.fields.employeeCount).toBe(18287);
    expect(mapped.fields).not.toHaveProperty("yearFounded"); // null in fixture
    expect(mapped.fields).not.toHaveProperty("specialties"); // [] → absent, not []
  });

  test("hq mapped; free-text country goes to hqCountry", () => {
    expect(mapped.hq).toEqual({
      addressLine: "220 Virginia Ave",
      city: "Indianapolis",
      region: "Indiana",
      postalCode: "46203",
      countryName: "United States",
    });
    expect(mapped.fields.hqCountry).toBe("United States");
    expect(mapped.fields.hqCity).toBe("Indianapolis");
  });

  test("headcount: monthly points normalized to first-of-month totals; empty by_function tolerated", () => {
    expect(mapped.headcount).toHaveLength(4);
    expect(mapped.headcount[0]).toEqual({ monthIso: "2026-05-01", jobFunction: "", count: 18262 });
    expect(mapped.headcount.every((p) => p.jobFunction === "")).toBe(true);
  });

  test("headcountDeltaPct: latest vs previous over totals", () => {
    const delta = headcountDeltaPct(mapped.headcount);
    expect(delta).toEqual({
      fromMonth: "2026-07-01",
      toMonth: "2026-08-01",
      from: 18282,
      to: 18287,
      pct: (18287 - 18282) / 18282,
    });
  });
});

describe("unit helpers", () => {
  test("mapOwnershipType vocabulary", () => {
    expect(mapOwnershipType("Public Company")).toBe("public");
    expect(mapOwnershipType("Privately Held")).toBe("private");
    expect(mapOwnershipType("Nonprofit")).toBe("nonprofit");
    expect(mapOwnershipType("Self-Employed")).toBe("self_employed");
    expect(mapOwnershipType("Weird New Thing")).toBe("other");
    expect(mapOwnershipType(null)).toBeNull();
    expect(mapOwnershipType("  ")).toBeNull();
  });

  test("revenueMinor units + unsafe-magnitude guard", () => {
    expect(revenueMinor(5, "MILLION")).toBe(500_000_000);
    expect(revenueMinor(20, "THOUSAND")).toBe(2_000_000);
    expect(revenueMinor(1, "BILLION")).toBe(100_000_000_000);
    expect(revenueMinor(3, "PARSECS")).toBeNull();
    expect(revenueMinor(999_999, "TRILLION")).toBeNull(); // > MAX_SAFE_INTEGER → dropped
  });

  test("revenueDisplay currency forms", () => {
    expect(
      revenueDisplay("USD", { amount: 5, unit: "MILLION" }, { amount: 10, unit: "MILLION" }),
    ).toBe("$5M–$10M");
    expect(revenueDisplay("EUR", { amount: 50, unit: "MILLION" }, null)).toBe("50M EUR");
    expect(revenueDisplay("USD", null, null)).toBeNull();
  });
});
