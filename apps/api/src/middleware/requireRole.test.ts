// requireRole.test.ts — proves the workspace-role guard (17 §5) authorizes correctly off the resolved
// membership role, WITHOUT a DB. workspaceRepository.getRoleForUser is the only external dependency the
// guard touches, so we mock @leadwolf/db before importing the middleware and drive it with a minimal Hono
// context stub (only the c.get/c.set the guard uses). We assert: allowed role passes + is stashed for
// getWorkspaceRole; a role outside the allow-list is denied 403; a non-member (null role) is denied 403;
// and a request with no selected workspace is denied 403 before the lookup ever runs.

import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { WorkspaceRole } from "@leadwolf/types";

// The role the mocked repository will return for the next guard invocation.
let nextRole: WorkspaceRole | null = "admin";
let lookupCalls = 0;

mock.module("@leadwolf/db", () => ({
  workspaceRepository: {
    getRoleForUser: async (_tenantId: string, _workspaceId: string, _userId: string) => {
      lookupCalls += 1;
      return nextRole;
    },
  },
}));

// Import AFTER the mock is registered so the static `import { workspaceRepository }` binds to the stub.
const { requireRole, getWorkspaceRole } = await import("./requireRole.ts");

/** A throwaway Hono-ish context exposing only the get/set surface the guard reads/writes. */
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
  nextRole = "admin";
  lookupCalls = 0;
});

describe("requireRole", () => {
  it("calls next() and stashes the role when the resolved role is allowed", async () => {
    nextRole = "admin";
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    let nexted = false;
    await requireRole("owner", "admin")(c, async () => {
      nexted = true;
    });
    expect(nexted).toBe(true);
    expect(lookupCalls).toBe(1);
    expect(getWorkspaceRole(c)).toBe("admin");
  });

  it("rejects with a 403 when the resolved role is not in the allow-list", async () => {
    nextRole = "viewer";
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    let nexted = false;
    await expect(
      requireRole("owner", "admin")(c, async () => {
        nexted = true;
      }),
    ).rejects.toMatchObject({ status: 403, code: "insufficient_role" });
    expect(nexted).toBe(false);
  });

  it("rejects with a 403 when the caller is not an active member (null role)", async () => {
    nextRole = null;
    const c = makeContext({ claims, tenantId: "t1", workspaceId: "w1" });
    await expect(requireRole("member")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "insufficient_role",
    });
  });

  it("rejects with a 403 before any lookup when no workspace is selected", async () => {
    const c = makeContext({ claims, tenantId: "t1", workspaceId: undefined });
    await expect(requireRole("owner")(c, async () => undefined)).rejects.toMatchObject({
      status: 403,
      code: "no_workspace",
    });
    expect(lookupCalls).toBe(0);
  });
});
