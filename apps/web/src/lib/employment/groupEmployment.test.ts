// groupEmployment.test.ts — the LinkedIn-shaped grouping of employment stints. [S-09] [S-13]

import { describe, expect, test } from "bun:test";
import { type EmploymentStintInput, groupStints } from "./groupEmployment";

const NOW = new Date("2026-08-25T00:00:00.000Z");

function stint(over: Partial<EmploymentStintInput> = {}): EmploymentStintInput {
  return {
    groupKey: "co:acme",
    companyName: "Acme",
    title: null,
    isCurrent: false,
    startedOn: null,
    endedOn: null,
    startPrecision: "month",
    endPrecision: "month",
    ...over,
  };
}

describe("the promotion case", () => {
  test("two roles at one company render as ONE block, titles in sequence, current first", () => {
    // The reported case verbatim: promoted from Finance Manager to Finance Director at the same employer.
    // Flat, this was two rows with "Acme" printed twice and nothing tying them together.
    const groups = groupStints(
      [
        stint({
          title: "Finance Manager",
          startedOn: "2019-03-01",
          endedOn: "2023-06-01",
        }),
        stint({ title: "Finance Director", startedOn: "2023-06-01", isCurrent: true }),
      ],
      NOW,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0]?.companyName).toBe("Acme");
    expect(groups[0]?.roles.map((r) => r.title)).toEqual(["Finance Director", "Finance Manager"]);
    expect(groups[0]?.isCurrent).toBe(true);
  });

  test("the company block carries the TOTAL tenure, not just the current role's", () => {
    const groups = groupStints(
      [
        stint({ title: "Finance Manager", startedOn: "2019-03-01", endedOn: "2023-06-01" }),
        stint({ title: "Finance Director", startedOn: "2023-06-01", isCurrent: true }),
      ],
      NOW,
    );
    // 2019-03 → now (2026-08) is 7y 5m at the company; the current role alone is 3y 2m.
    expect(groups[0]?.totalDuration).toBe("7y 5m");
    expect(groups[0]?.roles[0]?.duration).toBe("3y 2m");
  });

  test("input order does not matter — the two read paths order differently", () => {
    const ascending = groupStints(
      [
        stint({ title: "Finance Manager", startedOn: "2019-03-01", endedOn: "2023-06-01" }),
        stint({ title: "Finance Director", startedOn: "2023-06-01", isCurrent: true }),
      ],
      NOW,
    );
    const descending = groupStints(
      [
        stint({ title: "Finance Director", startedOn: "2023-06-01", isCurrent: true }),
        stint({ title: "Finance Manager", startedOn: "2019-03-01", endedOn: "2023-06-01" }),
      ],
      NOW,
    );
    expect(ascending[0]?.roles.map((r) => r.title)).toEqual(
      descending[0]?.roles.map((r) => r.title),
    );
  });
});

describe("company identity", () => {
  test("two companies that share a NAME stay apart when their keys differ", () => {
    const groups = groupStints(
      [
        stint({ groupKey: "co:one", companyName: "Apex", title: "Analyst" }),
        stint({ groupKey: "co:two", companyName: "Apex", title: "Engineer" }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(2);
  });

  test("one company written two ways stays together when the key matches", () => {
    const groups = groupStints(
      [
        stint({ groupKey: "co:acme", companyName: "Acme Inc.", title: "Analyst" }),
        stint({ groupKey: "co:acme", companyName: "Acme, Inc", title: "Engineer" }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.roles).toHaveLength(2);
  });

  test("with no key, grouping folds on the case-normalized name", () => {
    // The rollout window: an older API build ships no groupKey. Falling back on the name is worse than the
    // key but far better than not grouping at all.
    const groups = groupStints(
      [
        stint({ groupKey: null, companyName: "Acme", title: "Analyst" }),
        stint({ groupKey: null, companyName: "ACME", title: "Engineer" }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(1);
  });

  test("unnamed, unkeyed stints are never folded into one employer", () => {
    // Nothing in the record says these two are the same company, so claiming it would be an invention.
    const groups = groupStints(
      [
        stint({ groupKey: null, companyName: null, title: "Analyst" }),
        stint({ groupKey: null, companyName: null, title: "Engineer" }),
      ],
      NOW,
    );
    expect(groups[0]?.roles).toHaveLength(2);
    expect(groups[0]?.companyName).toBeNull();
  });
});

describe("phantom stints from precision refinement", () => {
  test("the same role re-asserted at a finer precision folds into one role", () => {
    // A source that refines "2018" to "2018-03" mints a SECOND row, because the dedup key is
    // (person, company, started_on). Rendered flat that reads as a promotion into the same job.
    const groups = groupStints(
      [
        stint({ title: "Engineer", startedOn: "2018-01-01", startPrecision: "year" }),
        stint({ title: "Engineer", startedOn: "2018-03-01", startPrecision: "month" }),
      ],
      NOW,
    );
    expect(groups[0]?.roles).toHaveLength(1);
    // The more precise assertion wins.
    expect(groups[0]?.roles[0]?.startedOn).toBe("2018-03-01");
  });

  test("a genuine re-hire into the same title years later survives as its own role", () => {
    const groups = groupStints(
      [
        stint({ title: "Engineer", startedOn: "2012-01-01", endedOn: "2014-01-01" }),
        stint({ title: "Engineer", startedOn: "2020-01-01", endedOn: "2022-01-01" }),
      ],
      NOW,
    );
    expect(groups[0]?.roles).toHaveLength(2);
  });

  test("two untitled stints are never folded — nothing proves they are one role", () => {
    const groups = groupStints(
      [stint({ startedOn: "2018-01-01" }), stint({ startedOn: "2018-03-01" })],
      NOW,
    );
    expect(groups[0]?.roles).toHaveLength(2);
  });
});

describe("sparse data degrades cleanly", () => {
  test("a bare edge is flagged so the UI can render one company line", () => {
    // The live import path mints company + is_current only (planning doc 33 §A2).
    const groups = groupStints([stint({ isCurrent: true })], NOW);
    expect(groups[0]?.isBareEdge).toBe(true);
    expect(groups[0]?.totalDuration).toBeNull();
  });

  test("a company with real roles is not a bare edge", () => {
    const groups = groupStints([stint({ title: "Engineer" })], NOW);
    expect(groups[0]?.isBareEdge).toBe(false);
  });

  test("an unknown start never becomes a duration", () => {
    // started_on's '-infinity' sentinel arrives here as null; measuring from it reads as ~2000 years.
    const groups = groupStints([stint({ title: "Engineer", isCurrent: true })], NOW);
    expect(groups[0]?.roles[0]?.duration).toBeNull();
    expect(groups[0]?.totalDuration).toBeNull();
  });

  test("a year-precision start never becomes a duration either", () => {
    // "2018" could be eleven months of difference; a tenure is a number people repeat out loud.
    const groups = groupStints(
      [
        stint({
          title: "Engineer",
          startedOn: "2018-01-01",
          startPrecision: "year",
          isCurrent: true,
        }),
      ],
      NOW,
    );
    expect(groups[0]?.roles[0]?.duration).toBeNull();
  });

  test("roles with unknown starts sink below dated ones", () => {
    const groups = groupStints(
      [
        stint({ title: "Unknown when" }),
        stint({ title: "Dated", startedOn: "2020-01-01", endedOn: "2021-01-01" }),
      ],
      NOW,
    );
    expect(groups[0]?.roles.map((r) => r.title)).toEqual(["Dated", "Unknown when"]);
  });
});

describe("ordering and keys", () => {
  test("the current company leads, past companies follow by recency", () => {
    const groups = groupStints(
      [
        stint({
          groupKey: "co:old",
          companyName: "Old",
          title: "A",
          startedOn: "2010-01-01",
          endedOn: "2014-01-01",
        }),
        stint({
          groupKey: "co:now",
          companyName: "Now",
          title: "B",
          startedOn: "2022-01-01",
          isCurrent: true,
        }),
        stint({
          groupKey: "co:mid",
          companyName: "Mid",
          title: "C",
          startedOn: "2016-01-01",
          endedOn: "2021-01-01",
        }),
      ],
      NOW,
    );
    expect(groups.map((g) => g.companyName)).toEqual(["Now", "Mid", "Old"]);
  });

  test("more than one concurrent current role is legal and kept", () => {
    // master_employment allows several is_current rows; only is_primary is unique per person.
    const groups = groupStints(
      [
        stint({
          groupKey: "co:a",
          companyName: "A",
          title: "Advisor",
          isCurrent: true,
          startedOn: "2024-01-01",
        }),
        stint({
          groupKey: "co:b",
          companyName: "B",
          title: "CTO",
          isCurrent: true,
          startedOn: "2023-01-01",
        }),
      ],
      NOW,
    );
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.isCurrent)).toBe(true);
  });

  test("every role id is unique, so they are safe as React keys", () => {
    // Two roles at one company with the same title and no dates collided on the composite key alone.
    const groups = groupStints([stint({ title: "Engineer" }), stint({ title: "Engineer" })], NOW);
    const ids = groups.flatMap((g) => g.roles.map((r) => r.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("an empty history yields no groups rather than an empty block", () => {
    expect(groupStints([], NOW)).toEqual([]);
  });
});
