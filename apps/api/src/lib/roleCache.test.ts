import { describe, expect, test } from "bun:test";
import { roleCacheEnabled, roleKey } from "./roleCache.ts";

describe("role cache", () => {
  test("is OFF by default — every request reads the authoritative row", () => {
    // The shipped default is today's behaviour exactly. Enabling it trades a small failure-mode window for
    // the round trips, which is an operator decision (see the module header).
    expect(roleCacheEnabled()).toBe(false);
  });

  test("the key carries tenant, workspace AND user", () => {
    // Dropping any one of the three would let a role leak across a boundary: the same user holds different
    // roles in different workspaces, and workspace ids are only unique within a tenant.
    expect(roleKey("t1", "w1", "u1")).toBe("role:t1:w1:u1");
    expect(roleKey("t1", "w2", "u1")).not.toBe(roleKey("t1", "w1", "u1"));
    expect(roleKey("t2", "w1", "u1")).not.toBe(roleKey("t1", "w1", "u1"));
    expect(roleKey("t1", "w1", "u2")).not.toBe(roleKey("t1", "w1", "u1"));
  });
});
