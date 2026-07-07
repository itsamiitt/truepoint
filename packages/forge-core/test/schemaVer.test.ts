import { describe, expect, test } from "bun:test";
import {
  canAutoPublish,
  classifyBump,
  compareSchemaVer,
  parseSchemaVer,
  requiredCompatibility,
  requiresDifferentialTest,
} from "../src/index.ts";

describe("SchemaVer", () => {
  test("parse + compare + reject invalid", () => {
    expect(parseSchemaVer("2-1-3")).toEqual({ model: 2, revision: 1, addition: 3 });
    expect(compareSchemaVer(parseSchemaVer("1-0-0"), parseSchemaVer("1-0-1"))).toBeLessThan(0);
    expect(compareSchemaVer(parseSchemaVer("2-0-0"), parseSchemaVer("1-9-9"))).toBeGreaterThan(0);
    expect(() => parseSchemaVer("bad")).toThrow();
  });

  test("classifyBump maps a change to its compatibility + publish rule", () => {
    const base = parseSchemaVer("1-0-0");
    expect(classifyBump(base, parseSchemaVer("1-0-1"))).toBe("ADDITION");
    expect(classifyBump(base, parseSchemaVer("1-1-0"))).toBe("REVISION");
    expect(classifyBump(base, parseSchemaVer("2-0-0"))).toBe("MODEL");

    // ADDITION auto-publishes; REVISION/MODEL require a differential test (08 §Schema evolution).
    expect(canAutoPublish("ADDITION")).toBe(true);
    expect(canAutoPublish("REVISION")).toBe(false);
    expect(requiresDifferentialTest("REVISION")).toBe(true);
    expect(requiresDifferentialTest("MODEL")).toBe(true);
    expect(requiredCompatibility("ADDITION")).toBe("FULL");
    expect(requiredCompatibility("MODEL")).toBe("NONE");
  });
});
