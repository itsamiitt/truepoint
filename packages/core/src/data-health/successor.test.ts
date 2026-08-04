import { describe, expect, test } from "bun:test";
import {
  SUCCESSOR_MIN_SCORE,
  rankSuccessors,
  scoreSuccessor,
  seniorityProximity,
} from "./successor.ts";

const departed = {
  title: "VP of Sales",
  seniorityLevel: "vp",
  department: "Sales",
};

describe("seniorityProximity", () => {
  test("same rung is 1, adjacent is high, far is low", () => {
    expect(seniorityProximity("vp", "vp")).toBe(1);
    expect(seniorityProximity("vp", "director")).toBeGreaterThan(0.6);
    expect(seniorityProximity("c_suite", "ic")).toBe(0);
  });

  test("unknown seniority is NEUTRAL, not zero", () => {
    // Absent data is not evidence of a bad fit. Scoring it zero would bury every candidate whose seniority we
    // simply have not resolved — which is most of them, early on.
    expect(seniorityProximity(null, "vp")).toBe(0.5);
    expect(seniorityProximity("vp", "something_else")).toBe(0.5);
  });
});

describe("scoreSuccessor", () => {
  test("the same title at the same level scores near the top", () => {
    const s = scoreSuccessor(departed, {
      id: "a",
      title: "VP of Sales",
      seniorityLevel: "vp",
      department: "Sales",
    });
    expect(s?.score).toBeGreaterThan(0.9);
    expect(s?.reasons).toContain("same_title");
    expect(s?.reasons).toContain("same_seniority");
  });

  test("a manager one rung below still ranks — that is the common backfill", () => {
    // The realistic successor is often one rung down. An equality test on seniority would rank this level
    // with an unrelated IC, which is the whole reason proximity is a distance.
    const s = scoreSuccessor(departed, {
      id: "b",
      title: "Sales Manager",
      seniorityLevel: "manager",
      department: "Sales",
    });
    expect(s?.score).toBeGreaterThan(SUCCESSOR_MIN_SCORE);
  });

  test("an unrelated senior person does not win on seniority alone", () => {
    const engineer = scoreSuccessor(departed, {
      id: "c",
      title: "VP of Engineering",
      seniorityLevel: "vp",
      department: "Engineering",
    });
    const salesMgr = scoreSuccessor(departed, {
      id: "d",
      title: "Sales Manager",
      seniorityLevel: "manager",
      department: "Sales",
    });
    // Same seniority as the departed, but the wrong job. Title carries the most weight for exactly this case.
    expect(engineer?.score).toBeLessThan((salesMgr?.score ?? 0) + 0.2);
    expect(engineer?.reasons).not.toContain("same_department");
  });

  test("nothing to compare on returns null rather than a number", () => {
    // A score built from no signal is a guess wearing a number, and S-14 only pays off if a suggestion is
    // trustworthy enough to act on without re-checking.
    expect(scoreSuccessor({}, { id: "e" })).toBeNull();
  });

  test("title formatting differences do not change the verdict", () => {
    const a = scoreSuccessor(departed, { id: "f", title: "VP, Sales", seniorityLevel: "vp" });
    const b = scoreSuccessor(departed, { id: "g", title: "vp sales", seniorityLevel: "vp" });
    expect(Math.abs((a?.score ?? 0) - (b?.score ?? 0))).toBeLessThan(0.02);
  });
});

describe("rankSuccessors", () => {
  const pool = [
    { id: "sales-mgr", title: "Sales Manager", seniorityLevel: "manager", department: "Sales" },
    { id: "vp-sales", title: "VP of Sales", seniorityLevel: "vp", department: "Sales" },
    { id: "intern", title: "Marketing Intern", seniorityLevel: "ic", department: "Marketing" },
  ];

  test("best first, and the obviously wrong candidate is dropped entirely", () => {
    const out = rankSuccessors(departed, pool);
    expect(out[0]?.candidateId).toBe("vp-sales");
    // "Here are five colleagues, one might be right" is what the seller could already do by scrolling the
    // company. A weak list is worse than an empty one — it teaches them the feature does not work.
    expect(out.map((s) => s.candidateId)).not.toContain("intern");
  });

  test("respects the limit", () => {
    expect(rankSuccessors(departed, pool, 1)).toHaveLength(1);
    expect(rankSuccessors(departed, pool, 0)).toHaveLength(0);
  });

  test("no plausible successor yields an empty list, not a bad one", () => {
    const out = rankSuccessors(departed, [
      { id: "x", title: "Warehouse Associate", seniorityLevel: "ic", department: "Ops" },
    ]);
    expect(out).toEqual([]);
  });

  test("ordering is deterministic when scores tie", () => {
    // An unstable list that reshuffles between renders reads as broken.
    const tied = [
      { id: "bbb", title: "VP of Sales", seniorityLevel: "vp", department: "Sales" },
      { id: "aaa", title: "VP of Sales", seniorityLevel: "vp", department: "Sales" },
    ];
    expect(rankSuccessors(departed, tied).map((s) => s.candidateId)).toEqual(["aaa", "bbb"]);
    expect(rankSuccessors(departed, [...tied].reverse()).map((s) => s.candidateId)).toEqual([
      "aaa",
      "bbb",
    ]);
  });
});
