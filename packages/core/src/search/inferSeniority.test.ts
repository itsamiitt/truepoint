import { describe, expect, test } from "bun:test";
import { inferSeniorityFromTitle } from "./inferSeniority.ts";

describe("inferSeniorityFromTitle", () => {
  test("c-suite forms", () => {
    expect(inferSeniorityFromTitle("Chief Executive Officer")).toBe("c_suite");
    expect(inferSeniorityFromTitle("CTO & Co-Founder")).toBe("c_suite");
    expect(inferSeniorityFromTitle("Managing Partner")).toBe("c_suite");
  });
  test("vp / head of", () => {
    expect(inferSeniorityFromTitle("VP Sales")).toBe("vp");
    expect(inferSeniorityFromTitle("Senior Vice President, Marketing")).toBe("vp");
    expect(inferSeniorityFromTitle("Head of Growth")).toBe("vp");
  });
  test("director / manager / ic", () => {
    expect(inferSeniorityFromTitle("Director of Engineering")).toBe("director");
    expect(inferSeniorityFromTitle("Engineering Manager")).toBe("manager");
    expect(inferSeniorityFromTitle("Senior Software Engineer")).toBe("ic");
    expect(inferSeniorityFromTitle("Account Executive")).toBe("ic");
  });
  test("most-senior rung wins when several are mentioned", () => {
    expect(inferSeniorityFromTitle("Director & Head of Product")).toBe("vp");
  });
  test("unknown or empty → null (never a guess)", () => {
    expect(inferSeniorityFromTitle("Ninja Wizard")).toBeNull();
    expect(inferSeniorityFromTitle("")).toBeNull();
    expect(inferSeniorityFromTitle(null)).toBeNull();
  });
});
