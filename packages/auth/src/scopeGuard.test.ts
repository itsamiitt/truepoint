// scopeGuard.test.ts — the cross-tenant auth-bypass regression guard (Phase 0a). Proves a client-supplied
// tenantId the user is not a member of is rejected before it can be minted into a JWT `tid` claim.

import { describe, expect, it } from "bun:test";
import { ForbiddenError, InvalidCredentialsError } from "@leadwolf/types";
import { authorizeTenantSelection } from "./scopeGuard.ts";

describe("authorizeTenantSelection", () => {
  const memberships = [{ tenantId: "tenant-own" }, { tenantId: "tenant-second" }];

  it("rejects a client-supplied tenantId the user is NOT a member of (the bypass)", () => {
    expect(() => authorizeTenantSelection(memberships, "tenant-victim")).toThrow(ForbiddenError);
  });

  it("accepts a client-supplied tenantId that matches an active membership", () => {
    expect(authorizeTenantSelection(memberships, "tenant-second")).toBe("tenant-second");
  });

  it("falls back to the sole membership when none is supplied", () => {
    expect(authorizeTenantSelection([{ tenantId: "tenant-solo" }], undefined)).toBe("tenant-solo");
  });

  it("throws when the user has no active memberships at all", () => {
    expect(() => authorizeTenantSelection([], undefined)).toThrow(InvalidCredentialsError);
  });
});
