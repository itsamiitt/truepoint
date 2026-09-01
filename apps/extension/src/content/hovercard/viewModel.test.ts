// viewModel.test.ts — the person-card state ladder (P0–P11) and the company card (C0–C3), table-driven over
// the PURE derivers. The money rules pinned here are the ones a repaint bug would silently break:
//   • price labels carry the SERVER's number and never an invented literal;
//   • credits gating disables at `credits < cost` and NOT at `credits === cost`;
//   • the masked `••••@domain` shape renders only when the workspace contact row exists;
//   • `nothingToReveal` reads "nothing on file", never "already owned".
import { describe, expect, it } from "bun:test";
import type { ProfileIntelResponse } from "@leadwolf/types";
import type { IntelPayload } from "../../shared/messages.ts";
import type { CapturedRecord, SubjectStatus } from "../../shared/types.ts";
import {
  type PersonVmInput,
  deriveCompanyVm,
  derivePersonVm,
  humanizeSlug,
  personDeepLink,
} from "./viewModel.ts";

const record: CapturedRecord = {
  subjectKey: "jane-doe",
  adapter: "linkedin",
  pageType: "profile",
  fields: { fullName: "Jane Doe", jobTitle: "VP Sales", company: "Acme" },
  sourceUrl: "https://www.linkedin.com/in/jane-doe",
  capturedAt: "2026-08-01T00:00:00.000Z",
};

function status(over: Partial<SubjectStatus>): SubjectStatus {
  return { contactId: null, known: false, owned: false, outcome: "unknown", ...over };
}

function intelResponse(over: Partial<ProfileIntelResponse>): ProfileIntelResponse {
  return {
    kind: "person",
    status: "found",
    contactId: "11111111-1111-4111-8111-111111111111",
    owned: false,
    person: {
      linkedinPublicId: "jane-doe",
      linkedinUrl: "https://www.linkedin.com/in/jane-doe",
      fullName: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      headline: null,
      jobTitle: "VP Sales",
      seniorityLevel: "vp",
      locationRaw: "Austin, TX",
      locationCity: "Austin",
      locationCountry: "US",
      companyName: "Acme",
      companyDomain: "acme.example",
      companyIndustry: null,
      hasEmail: true,
      hasPhone: true,
      updatedAt: "2026-08-01T00:00:00.000Z",
      inWorkspace: null,
    },
    contact: {
      id: "11111111-1111-4111-8111-111111111111",
      firstName: "Jane",
      lastName: "Doe",
      jobTitle: "VP Sales",
      emailDomain: "acme.example",
      companyName: "Acme",
      emailStatus: "valid",
      phoneStatus: null,
      hasEmail: true,
      hasPhone: true,
      seniorityLevel: "vp",
      department: null,
      locationCountry: "US",
      locationCity: "Austin",
      outreachStatus: "new",
      isRevealed: false,
      ownerUserId: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      lastVerifiedAt: null,
    },
    profile: null,
    company: null,
    signals: [],
    ...over,
  } as ProfileIntelResponse;
}

function payload(over?: {
  intel?: Partial<ProfileIntelResponse>;
  costs?: IntelPayload["costs"];
  revealed?: IntelPayload["revealed"];
}): IntelPayload {
  return {
    intel: intelResponse(over?.intel ?? {}),
    costs: over?.costs !== undefined ? over.costs : { email: 1, phone: 5, full_profile: 5 },
    revealed: over?.revealed ?? null,
    fetchedAt: Date.now(),
  };
}

function input(over: Partial<PersonVmInput>): PersonVmInput {
  return {
    record,
    status: null,
    intel: null,
    intelState: "idle",
    credits: 100,
    busy: null,
    justRevealed: null,
    copied: null,
    revealError: null,
    ...over,
  };
}

describe("derivePersonVm — the lookup ladder (thin tiers)", () => {
  it("P0: no status yet — checking, no actions", () => {
    const vm = derivePersonVm(input({}));
    expect(vm.phase).toBe("P0");
    expect(vm.pill).toBe("Checking TruePoint…");
    expect(vm.buttons).toHaveLength(0);
    expect(vm.name).toBe("Jane Doe");
  });

  it("P1: suppressed — no actions at all", () => {
    const vm = derivePersonVm(input({ status: status({ outcome: "suppressed" }) }));
    expect(vm.phase).toBe("P1");
    expect(vm.buttons).toHaveLength(0);
  });

  it("P2/P3/P4: queued, not_found, unavailable all offer Save", () => {
    for (const outcome of ["queued", "not_found", "unavailable"] as const) {
      const vm = derivePersonVm(input({ status: status({ outcome }) }));
      expect(vm.buttons.map((b) => b.id)).toEqual(["save"]);
    }
  });

  it("P5: an unknown outcome is a failed check — retry plus Save", () => {
    const vm = derivePersonVm(input({ status: status({ outcome: "unknown" }) }));
    expect(vm.phase).toBe("P5");
    expect(vm.buttons.map((b) => b.id)).toEqual(["retryLookup", "save"]);
  });

  it("P6: found with the intel read in flight — skeleton, no buttons", () => {
    const vm = derivePersonVm(
      input({
        status: status({ outcome: "found", contactId: "c1", known: true }),
        intelState: "loading",
      }),
    );
    expect(vm.phase).toBe("P6");
    expect(vm.skeleton).toBe(true);
    expect(vm.buttons).toHaveLength(0);
  });

  it("P11: intel failed — falls back to the thin card, still opens the panel", () => {
    const vm = derivePersonVm(
      input({
        status: status({ outcome: "in_database" }),
        intelState: "error",
      }),
    );
    expect(vm.phase).toBe("P11");
    expect(vm.buttons.map((b) => b.id)).toEqual(["add"]);
    expect(vm.openPanelLabel).not.toBeNull();
  });
});

describe("derivePersonVm — P7 in database", () => {
  const p7 = (): ReturnType<typeof derivePersonVm> =>
    derivePersonVm(
      input({
        status: status({ outcome: "in_database" }),
        intel: payload({ intel: { status: "in_database", contactId: null, contact: null } }),
        intelState: "ready",
      }),
    );

  it("offers the free add, never a reveal", () => {
    const vm = p7();
    expect(vm.phase).toBe("P7");
    expect(vm.buttons.map((b) => b.id)).toEqual(["add"]);
  });

  it("shows presence lines only — no masked domain without a workspace contact row", () => {
    const vm = p7();
    const emailLine = vm.channels.find((c) => c.id === "email");
    expect(emailLine?.line).toBe("Email on record");
    expect(emailLine?.line).not.toContain("@");
    expect(emailLine?.masked).toBe(false);
  });
});

describe("derivePersonVm — P8 found, not revealed (the money tier)", () => {
  const found = status({ outcome: "found", contactId: "c1", known: true });

  it("prices both buttons from the server's costs, never a literal", () => {
    const vm = derivePersonVm(
      input({
        status: found,
        intel: payload({ costs: { email: 3, phone: 7, full_profile: 9 } }),
        intelState: "ready",
      }),
    );
    expect(vm.phase).toBe("P8");
    const labels = vm.buttons.map((b) => b.label);
    expect(labels[0]).toContain(String(3));
    expect(labels[1]).toContain(String(7));
  });

  it("renders unpriced labels when the cost lookup has not answered", () => {
    const vm = derivePersonVm(
      input({ status: found, intel: payload({ costs: null }), intelState: "ready" }),
    );
    expect(vm.buttons[0]?.label).toBe("Reveal email");
    expect(vm.buttons[0]?.disabled).toBe(false);
  });

  it("masks the email with the CONTACT's own domain", () => {
    const vm = derivePersonVm(input({ status: found, intel: payload(), intelState: "ready" }));
    expect(vm.channels.find((c) => c.id === "email")?.line).toBe("••••••••@acme.example");
    expect(vm.channels.find((c) => c.id === "email")?.masked).toBe(true);
  });

  it("credits gate: exactly-enough is enabled, one-short is disabled with the hint", () => {
    const costs = { email: 5, phone: 5, full_profile: 5 };
    const exact = derivePersonVm(
      input({ status: found, intel: payload({ costs }), intelState: "ready", credits: 5 }),
    );
    expect(exact.buttons[0]?.disabled).toBe(false);
    expect(exact.hint).toBeNull();

    const short = derivePersonVm(
      input({ status: found, intel: payload({ costs }), intelState: "ready", credits: 4 }),
    );
    expect(short.buttons[0]?.disabled).toBe(true);
    expect(short.hint).toBe("Not enough credits");
  });

  it("an in-flight reveal reads as busy", () => {
    const vm = derivePersonVm(
      input({ status: found, intel: payload(), intelState: "ready", busy: "email" }),
    );
    expect(vm.buttons[0]?.label).toBe("Revealing…");
    expect(vm.buttons[0]?.disabled).toBe(true);
  });
});

describe("derivePersonVm — P9/P10 revealed", () => {
  const found = status({ outcome: "found", contactId: "c1", known: true });

  it("P9: shows the value with a Verified badge and a copy affordance", () => {
    const vm = derivePersonVm(
      input({
        status: found,
        intel: payload(),
        intelState: "ready",
        justRevealed: { email: "jane@acme.example" },
      }),
    );
    expect(vm.phase).toBe("P9");
    const email = vm.channels.find((c) => c.id === "email");
    expect(email?.line).toBe("jane@acme.example");
    expect(email?.isValue).toBe(true);
    expect(email?.badge?.text).toBe("Verified");
    expect(vm.freshnessLine).not.toBeNull();
  });

  it("P9: the unrevealed phone keeps its priced reveal button", () => {
    const vm = derivePersonVm(
      input({
        status: found,
        intel: payload({ costs: { email: 1, phone: 7, full_profile: 8 } }),
        intelState: "ready",
        justRevealed: { email: "jane@acme.example" },
      }),
    );
    expect(vm.buttons.map((b) => b.id)).toEqual(["revealPhone", "openApp"]);
    expect(vm.buttons[0]?.label).toContain("7");
  });

  it("P10: nothingToReveal reads 'nothing on file', never 'already owned'", () => {
    const vm = derivePersonVm(
      input({
        status: found,
        intel: payload(),
        intelState: "ready",
        justRevealed: { nothing: true },
      }),
    );
    expect(vm.phase).toBe("P10");
    expect(vm.hint).toBe("Nothing on file for this contact");
  });
});

describe("personDeepLink", () => {
  const origin = "https://app.truepoint.in";

  it("prefers the server intel's public id", () => {
    expect(personDeepLink(origin, { intel: payload(), status: null, record })).toBe(
      "https://app.truepoint.in/search?person=jane-doe",
    );
  });

  it("uses the subject key itself when it IS the public slug", () => {
    expect(personDeepLink(origin, { intel: null, status: null, record })).toBe(
      "https://app.truepoint.in/search?person=jane-doe",
    );
  });

  it("a sales-lead key is never a slug — falls back to the bare workspace", () => {
    const lead = { ...record, subjectKey: "sales-lead:12345", fields: {} };
    expect(personDeepLink(origin, { intel: null, status: null, record: lead })).toBe(
      "https://app.truepoint.in/search",
    );
  });

  it("URL-encodes the slug", () => {
    const odd = { ...record, subjectKey: "j%C3%A9an d", fields: { publicId: "jéan d" } };
    expect(personDeepLink(origin, { intel: null, status: null, record: odd })).toBe(
      `https://app.truepoint.in/search?person=${encodeURIComponent("jéan d")}`,
    );
  });
});

describe("company card", () => {
  const subject = {
    kind: "company" as const,
    subjectKey: "company:acme-corp",
    sourceUrl: "https://www.linkedin.com/company/acme-corp",
  };

  it("humanizes a slug and NEVER renders a numeric Sales-Nav id", () => {
    expect(humanizeSlug("company:acme-corp")).toBe("Acme Corp");
    expect(humanizeSlug("company:1442600")).toBe("Company");
  });

  it("C0: loading shows the provisional slug name", () => {
    const vm = deriveCompanyVm({ subject, intel: null, intelState: "loading" });
    expect(vm.phase).toBe("C0");
    expect(vm.name).toBe("Acme Corp");
    expect(vm.openPanelLabel).toBeNull();
  });

  it("C3: a failed read offers retry", () => {
    const vm = deriveCompanyVm({ subject, intel: null, intelState: "error" });
    expect(vm.phase).toBe("C3");
    expect(vm.buttons.map((b) => b.id)).toEqual(["retryIntel"]);
  });

  it("C2: an empty company block says so plainly", () => {
    const vm = deriveCompanyVm({ subject, intel: payload(), intelState: "ready" });
    expect(vm.phase).toBe("C2");
    expect(vm.hint).toBe("TruePoint holds no company for this page yet.");
  });

  it("C1: derives the 12-month growth from the series, not a stored rollup", () => {
    // 13 oldest-first points, 100 → 200 over exactly 12 months = +100%.
    const series = Array.from({ length: 13 }, (_, i) => ({
      month: `2025-${String(i + 1).padStart(2, "0")}-01`,
      employeeCount: 100 + Math.round((i / 12) * 100),
    }));
    const company = {
      company: {
        primaryDomain: "acme.example",
        name: "Acme Corp",
        websiteUrl: null,
        logoUrl: null,
        description: null,
        linkedinCompanyUrl: null,
        industry: "Software",
        industryCode: null,
        industryLabel: null,
        employeeCount: 200,
        employeeBand: null,
        revenueMinMinor: null,
        revenueMaxMinor: null,
        revenueCurrency: null,
        revenueDisplay: null,
        ownershipType: null,
        yearFounded: 2015,
        specialties: [],
        hqCountry: "US",
        hqCity: "Austin",
        updatedAt: "2026-08-01T00:00:00.000Z",
        inWorkspace: null,
      },
      locations: [],
      headcountSeries: series,
    };
    const vm = deriveCompanyVm({
      subject,
      intel: payload({ intel: { kind: "company", contactId: null, contact: null, company } }),
      intelState: "ready",
    });
    expect(vm.phase).toBe("C1");
    expect(vm.name).toBe("Acme Corp");
    expect(vm.sub).toBe("Software · acme.example");
    expect(vm.headcount?.count).toContain("200");
    expect(vm.headcount?.growth).toContain("+100%");
    expect(vm.foundedHq).toBe("Founded 2015 · Austin, US");
    expect(vm.openPanelLabel).toBe("Open company profile");
  });
});
