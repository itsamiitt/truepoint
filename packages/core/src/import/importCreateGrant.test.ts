// importCreateGrant.test.ts — T-V6's decision-matrix half (import-redesign 10 §Testing): the pure G02
// grant verdict for every role × policy cell. The HTTP half (403 problem codes + the dual-gate ride) is
// exercised through the middleware in apps/api; the audited policy write is importPolicy.itest.ts.

import { describe, expect, it } from "bun:test";
import { evaluateImportCreateGrant } from "./importCreateGrant.ts";

describe("evaluateImportCreateGrant (10 §2.1 Create row × §3 policy knob)", () => {
  it("viewer is denied under either policy (read-only role product-wide)", () => {
    expect(evaluateImportCreateGrant("viewer", "member")).toBe("insufficient_role");
    expect(evaluateImportCreateGrant("viewer", "admin")).toBe("insufficient_role");
  });

  it("member is allowed under the default 'member' policy, denied under 'admin'", () => {
    expect(evaluateImportCreateGrant("member", "member")).toBe("ok");
    expect(evaluateImportCreateGrant("member", "admin")).toBe("disabled_by_policy");
  });

  it("elevated roles are allowed under either policy", () => {
    expect(evaluateImportCreateGrant("admin", "member")).toBe("ok");
    expect(evaluateImportCreateGrant("admin", "admin")).toBe("ok");
    expect(evaluateImportCreateGrant("owner", "member")).toBe("ok");
    expect(evaluateImportCreateGrant("owner", "admin")).toBe("ok");
  });
});
