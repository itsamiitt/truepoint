// keyMaterial.test.ts — proves the JWT PEM transport decode (ADR-0016 addendum). A multi-line PEM passed
// through docker compose `${VAR}` interpolation loses its newlines; the base64 transport survives intact.
// decodeKeyMaterial is pure, so we test it directly without mutating process.env.
import { describe, expect, it } from "bun:test";
import { decodeKeyMaterial } from "./env.ts";

const PEM =
  "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIabc123def456\n-----END PRIVATE KEY-----\n";
const b64 = Buffer.from(PEM, "utf8").toString("base64");

describe("decodeKeyMaterial", () => {
  it("returns the raw PEM verbatim when it is non-empty (raw wins over b64, back-compat)", () => {
    expect(decodeKeyMaterial(PEM, "aWdub3JlZA==")).toBe(PEM);
  });

  it("decodes the base64 transport when the raw PEM is empty, preserving newlines", () => {
    const out = decodeKeyMaterial("", b64);
    expect(out).toBe(PEM);
    expect(out).toContain("-----BEGIN PRIVATE KEY-----");
    expect(out).toContain("\n");
  });

  it("treats a whitespace-only raw PEM as empty and falls through to the b64 transport", () => {
    expect(decodeKeyMaterial("   \n  ", b64)).toBe(PEM);
  });

  it("returns an empty string when neither transport is provided", () => {
    expect(decodeKeyMaterial("", "")).toBe("");
    expect(decodeKeyMaterial("  ", "  ")).toBe("");
  });
});
