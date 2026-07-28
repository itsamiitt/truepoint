// evaluateFlag.test.ts — proves the flag-evaluation precedence (per-tenant override else global default,
// unknown flag fails closed). Pure unit test, no DB.

import { describe, expect, test } from "bun:test";
import { evaluateFlag, isFlagEnabled } from "./evaluateFlag.ts";

const defOff = { globalEnabled: false, defaultEnabled: false };
const defGlobalOn = { globalEnabled: true, defaultEnabled: false };
const defDefaultOn = { globalEnabled: false, defaultEnabled: true };

describe("evaluateFlag precedence", () => {
  test("a tenant override of true wins even when global+default are off", () => {
    const r = evaluateFlag({ key: "f", definition: defOff, override: true });
    expect(r).toEqual({ key: "f", enabled: true, source: "tenant_override" });
  });

  test("a tenant override of false wins even when global is on", () => {
    const r = evaluateFlag({ key: "f", definition: defGlobalOn, override: false });
    expect(r).toEqual({ key: "f", enabled: false, source: "tenant_override" });
  });

  test("no override + global_enabled → on, source=global", () => {
    const r = evaluateFlag({ key: "f", definition: defGlobalOn });
    expect(r).toEqual({ key: "f", enabled: true, source: "global" });
  });

  test("no override + global off + default on → on, source=default", () => {
    const r = evaluateFlag({ key: "f", definition: defDefaultOn });
    expect(r).toEqual({ key: "f", enabled: true, source: "default" });
  });

  test("no override + global off + default off → off, source=default", () => {
    const r = evaluateFlag({ key: "f", definition: defOff });
    expect(r).toEqual({ key: "f", enabled: false, source: "default" });
  });

  test("unknown flag (no definition) → off, source=unknown (fail closed)", () => {
    const r = evaluateFlag({ key: "ghost" });
    expect(r).toEqual({ key: "ghost", enabled: false, source: "unknown" });
  });

  test("isFlagEnabled mirrors evaluateFlag.enabled", () => {
    expect(isFlagEnabled({ key: "f", definition: defGlobalOn })).toBe(true);
    expect(isFlagEnabled({ key: "f", definition: defOff, override: false })).toBe(false);
    expect(isFlagEnabled({ key: "ghost" })).toBe(false);
  });
});
