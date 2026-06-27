// refreshDueMailboxTokens.test.ts — the proactive refresh sweep (M12 P1). Hermetic deps seam: proves it scopes
// each refresh to the mailbox's own tenant/workspace and that a per-mailbox failure never stalls the sweep.

import { describe, expect, it } from "bun:test";
import { type RefreshSweepDeps, refreshDueMailboxTokens } from "./refreshDueMailboxTokens.ts";

const DUE = [
  { id: "mbx-1", tenantId: "t1", workspaceId: "w1" },
  { id: "mbx-2", tenantId: "t2", workspaceId: "w2" },
  { id: "mbx-3", tenantId: "t1", workspaceId: "w1" },
];

describe("refreshDueMailboxTokens", () => {
  it("refreshes every due mailbox scoped to its own tenant/workspace", async () => {
    const calls: Array<{ scope: { tenantId: string; workspaceId: string }; id: string }> = [];
    const deps: RefreshSweepDeps = {
      listDueForRefresh: async () => DUE,
      refresh: async (scope, id) => {
        calls.push({ scope, id });
        return "at";
      },
    };

    const result = await refreshDueMailboxTokens({}, deps);

    expect(result).toEqual({ scanned: 3, refreshed: 3, failed: 0 });
    expect(calls).toEqual([
      { scope: { tenantId: "t1", workspaceId: "w1" }, id: "mbx-1" },
      { scope: { tenantId: "t2", workspaceId: "w2" }, id: "mbx-2" },
      { scope: { tenantId: "t1", workspaceId: "w1" }, id: "mbx-3" },
    ]);
  });

  it("keeps sweeping when one mailbox fails (reauth/transient is swallowed)", async () => {
    const deps: RefreshSweepDeps = {
      listDueForRefresh: async () => DUE,
      refresh: async (_scope, id) => {
        if (id === "mbx-2") throw new Error("invalid_grant → reauth");
        return "at";
      },
    };

    const result = await refreshDueMailboxTokens({}, deps);

    expect(result).toEqual({ scanned: 3, refreshed: 2, failed: 1 });
  });

  it("returns zeros on an empty worklist", async () => {
    const deps: RefreshSweepDeps = {
      listDueForRefresh: async () => [],
      refresh: async () => "at",
    };
    expect(await refreshDueMailboxTokens({}, deps)).toEqual({
      scanned: 0,
      refreshed: 0,
      failed: 0,
    });
  });
});
