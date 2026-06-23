// roleGuards.test.ts — the three role-TIER guards (workspace / org / staff) tested together in ONE file.
// They must share a single mock.module("@leadwolf/db"): bun's module mocks are process-global, so separate
// per-guard files each mocking @leadwolf/db clobber each other. One mock here exposes all three repositories,
// each reading a shared `next` state the individual tests set. Proves each guard authorizes off the resolved
// role, stashes it, applies its implies-all rule (workspace: none; org: owner; staff: super_admin), and
// rejects 403 for a disallowed role, a non-member (null), and — for workspace — a missing workspace.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { OrgRole, StaffRole, WorkspaceRole } from "@leadwolf/types";

const next: {
  ws: WorkspaceRole | null;
  org: OrgRole | null;
  staff: StaffRole | null;
  wsCalls: number;
} = { ws: "admin", org: "security_admin", staff: "support", wsCalls: 0 };

mock.module("@leadwolf/db", () => ({
  workspaceRepository: {
    getRoleForUser: async () => {
      next.wsCalls += 1;
      return next.ws;
    },
  },
  tenantMemberRepository: { getOrgRole: async () => next.org },
  platformStaffRepository: { getActiveRole: async () => next.staff },
}));

// Import the guards AFTER the mock is registered so their static @leadwolf/db imports bind to the stub.
const { requireRole, getWorkspaceRole } = await import("./requireRole.ts");
const { requireOrgRole, getOrgRole } = await import("./requireOrgRole.ts");
const { requireStaffRole, getStaffRole } = await import("./requireStaffRole.ts");

/** A throwaway Hono-ish context exposing only the get/set surface the guards read/write. */
function makeContext(vars: Record<string, unknown>) {
  const store = new Map<string, unknown>(Object.entries(vars));
  const c = {
    get: (k: string) => store.get(k),
    set: (k: string, v: unknown) => store.set(k, v),
    // biome-ignore lint/suspicious/noExplicitAny: minimal stub, not the full Hono Context type.
  } as any;
  return c;
}

const claims = { sub: "00000000-0000-0000-0000-000000000001" };

beforeEach(() => {
  next.ws = "admin";
  next.org = "security_admin";
  next.staff = "support";
  next.wsCalls = 0;
});

describe("requireRole (workspace tier)", () => {
  it("calls next() and stashes the role when allowed", async () => {
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    let nexted = false;
    await requireRole("owner", "admin")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(getWorkspaceRole(c)).toBe("admin");
  });

  it("rejects 403 when the role is not in the allow-list", async () => {
    next.ws = "viewer";
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    await expect(requireRole("owner", "admin")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_role",
    });
  });

  it("rejects 403 when the caller is not an active member (null role)", async () => {
    next.ws = null;
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    await expect(requireRole("member")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_role",
    });
  });

  it("rejects 403 before any lookup when no workspace is selected", async () => {
    const c = makeContext({ claims, tenantId: "t1", workspaceId: undefined });
    await expect(requireRole("owner")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "no_workspace",
    });
    expect(next.wsCalls).toBe(0);
  });
});

describe("requireOrgRole (tenant tier)", () => {
  it("calls next() and stashes the role when allowed", async () => {
    const c = makeContext({ claims, tenantId: "t1" });
    let nexted = false;
    await requireOrgRole("security_admin")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(getOrgRole(c)).toBe("security_admin");
  });

  it("lets `owner` through even when not in the allow-list (implies all)", async () => {
    next.org = "owner";
    const c = makeContext({ claims, tenantId: "t1" });
    let nexted = false;
    await requireOrgRole("billing_admin")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(getOrgRole(c)).toBe("owner");
  });

  it("rejects 403 when the role is not in the allow-list", async () => {
    next.org = "member";
    const c = makeContext({ claims, tenantId: "t1" });
    await expect(requireOrgRole("security_admin")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_org_role",
    });
  });

  it("rejects 403 when the caller is not an active member (null role)", async () => {
    next.org = null;
    const c = makeContext({ claims, tenantId: "t1" });
    await expect(requireOrgRole("owner")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_org_role",
    });
  });
});

describe("requireStaffRole (platform tier)", () => {
  it("calls next() and stashes the role when allowed", async () => {
    const c = makeContext({ claims });
    let nexted = false;
    await requireStaffRole("support", "compliance_officer")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(getStaffRole(c)).toBe("support");
  });

  it("lets `super_admin` through even when not in the allow-list (implies all)", async () => {
    next.staff = "super_admin";
    const c = makeContext({ claims });
    let nexted = false;
    await requireStaffRole("billing_ops")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(getStaffRole(c)).toBe("super_admin");
  });

  it("rejects 403 when the role is not in the allow-list", async () => {
    next.staff = "read_only";
    const c = makeContext({ claims });
    await expect(requireStaffRole("billing_ops")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_staff_role",
    });
  });

  it("rejects 403 when the caller is not active platform staff (null role)", async () => {
    next.staff = null;
    const c = makeContext({ claims });
    await expect(requireStaffRole("support")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_staff_role",
    });
  });
});
