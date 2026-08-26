// rowAffordances.test.ts — the outcome metrics of the 2026-08-25 decision, as assertions: a not-saved row
// exposes ZERO add affordances and no bulk checkbox, and 100 % of rows carrying a channel expose that
// channel's reveal control [S-04][S-06]; the deployment switch is the only thing that may hide it.
import { describe, expect, test } from "bun:test";
import type { MaskedContact } from "@leadwolf/types";
import type { ProspectRow } from "./databaseRows";
import { rowAffordances } from "./rowAffordances";

function row(over: Partial<ProspectRow>): ProspectRow {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    firstName: "Jane",
    lastName: "Doe",
    jobTitle: "VP Sales",
    emailDomain: "example.com",
    companyName: "Example",
    linkedinPublicId: "jane-doe",
    linkedinUrl: "https://www.linkedin.com/in/jane-doe",
    emailStatus: "unverified",
    phoneStatus: null,
    hasEmail: true,
    hasPhone: true,
    seniorityLevel: "vp",
    department: null,
    locationCountry: null,
    locationCity: null,
    outreachStatus: "new",
    isRevealed: false,
    ownerUserId: null,
    createdAt: "2026-08-25T00:00:00.000Z",
    lastVerifiedAt: null,
    ...over,
  } as ProspectRow;
}

const database = (over: Partial<ProspectRow> = {}) =>
  row({ id: "db:jane-doe", databaseSlug: "jane-doe", ...over });

describe("rowAffordances — what a Search row may do", () => {
  test("a not-saved row: no add, no bulk checkbox, LinkedIn-only menu, reveal for each channel on file", () => {
    const a = rowAffordances(database(), { databaseRevealEnabled: true });
    expect(a).toEqual({
      saved: false,
      reveal: { email: true, phone: true },
      select: false,
      add: false,
      actions: "linkedin",
    });
  });

  test("the deployment switch is the ONLY thing that hides a not-saved row's reveal", () => {
    const a = rowAffordances(database(), { databaseRevealEnabled: false });
    expect(a.reveal).toEqual({ email: false, phone: false });
    expect(a.add).toBe(false);
    expect(a.select).toBe(false);
  });

  test("a saved row keeps its bulk checkbox and full menu, and reveals regardless of the switch", () => {
    const a = rowAffordances(row({}), { databaseRevealEnabled: false });
    expect(a).toEqual({
      saved: true,
      reveal: { email: true, phone: true },
      select: true,
      add: false,
      actions: "full",
    });
  });

  test("100 % of rows with a phone on file expose a phone control; none without one do [S-04]", () => {
    const rows: ProspectRow[] = [
      database({ hasPhone: true, hasEmail: false }),
      database({ hasPhone: false, hasEmail: true }),
      row({ hasPhone: true }),
      row({ hasPhone: false }),
    ];
    for (const r of rows) {
      const a = rowAffordances(r, { databaseRevealEnabled: true });
      expect(a.reveal.phone).toBe(r.hasPhone);
      expect(a.reveal.email).toBe(r.hasEmail);
    }
  });

  test("the `add` affordance is unrepresentable — no row of any kind offers it", () => {
    const kinds: MaskedContact[] = [row({}), database()];
    for (const k of kinds) {
      expect(rowAffordances(k, { databaseRevealEnabled: true }).add).toBe(false);
      expect(rowAffordances(k, { databaseRevealEnabled: false }).add).toBe(false);
    }
  });
});
