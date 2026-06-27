// emailPrescreen.test.ts — the local role/disposable detectors + the pre-screen wrapper (short-circuit vs
// delegate). Pure + offline.
import { describe, expect, test } from "bun:test";
import { isDisposableDomain, isRoleAccount, localPrescreenVerifier } from "./emailPrescreen.ts";
import type { EmailVerifierPort } from "./emailVerifier.ts";

describe("isRoleAccount / isDisposableDomain", () => {
  test("role local-parts (incl. +tag)", () => {
    expect(isRoleAccount("info@acme.com")).toBe(true);
    expect(isRoleAccount("Sales+eu@acme.com")).toBe(true);
    expect(isRoleAccount("jane.doe@acme.com")).toBe(false);
  });
  test("disposable domains", () => {
    expect(isDisposableDomain("x@mailinator.com")).toBe(true);
    expect(isDisposableDomain("x@ACME.com")).toBe(false);
  });
  test("malformed → false", () => {
    expect(isRoleAccount("notanemail")).toBe(false);
    expect(isDisposableDomain("@")).toBe(false);
    expect(isRoleAccount("info@")).toBe(false);
  });
});

describe("localPrescreenVerifier", () => {
  const makeInner = () => {
    let calls = 0;
    const v: EmailVerifierPort = {
      name: "inner",
      verify: async () => {
        calls += 1;
        return "valid";
      },
    };
    return { v, calls: () => calls };
  };

  test("disposable → invalid without calling inner", async () => {
    const { v, calls } = makeInner();
    expect(await localPrescreenVerifier(v).verify("x@mailinator.com", "unverified")).toBe("invalid");
    expect(calls()).toBe(0);
  });
  test("role → risky without calling inner", async () => {
    const { v, calls } = makeInner();
    expect(await localPrescreenVerifier(v).verify("info@acme.com", "unverified")).toBe("risky");
    expect(calls()).toBe(0);
  });
  test("normal address delegates to inner", async () => {
    const { v, calls } = makeInner();
    expect(await localPrescreenVerifier(v).verify("jane@acme.com", "unverified")).toBe("valid");
    expect(calls()).toBe(1);
  });
  test("name wraps the inner name", () => {
    const v: EmailVerifierPort = { name: "reacher", verify: async () => "valid" };
    expect(localPrescreenVerifier(v).name).toBe("prescreen(reacher)");
  });
});
