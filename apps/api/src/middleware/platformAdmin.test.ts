// platformAdmin.test.ts — proves the platform-admin guard denies by default (ADR-0032): a caller without
// pa===true is rejected (ForbiddenError → 403); only a verified pa claim calls next(). These routes never
// run the tenancy middleware, so normal tenant isolation is unaffected.
import { describe, expect, it } from "bun:test";
import { ForbiddenError } from "@leadwolf/types";
import { platformAdmin } from "./platformAdmin.ts";

// Minimal Hono-Context stub exposing only c.get("claims").
const ctx = (claims: Record<string, unknown> | undefined) =>
  ({ get: (k: string) => (k === "claims" ? claims : undefined) }) as never;
const noop = async (): Promise<void> => {};

describe("platformAdmin guard", () => {
  it("rejects when there is no pa claim", async () => {
    await expect(platformAdmin(ctx({ sub: "u1" }), noop)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("rejects when pa is false", async () => {
    await expect(platformAdmin(ctx({ sub: "u1", pa: false }), noop)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("calls next when pa is true", async () => {
    let called = false;
    await platformAdmin(ctx({ sub: "u1", pa: true }), async () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
