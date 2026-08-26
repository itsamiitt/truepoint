// revocationMemo.test.ts — the negative deny-list memo has a ceiling.
//
// WHY. `isRevoked` memoises "not revoked" for 1s per session id to save a Redis round-trip on ~100% of
// authenticated requests. Nothing removed an entry: only `markRevoked` deletes, and that fires for the rare
// revoke, never for the overwhelming majority of sids that are simply live. So each entry went logically
// stale after a second and then sat in the map for the life of the process. Sessions rotate every ~14 minutes
// and every rotation mints a NEW sid, so the key space grew with time × active users rather than with
// concurrent sessions — a slow, permanent leak in a long-lived apps/api process that no request path would
// ever surface, because every individual lookup stayed correct and fast.

import { describe, expect, it } from "bun:test";
import { NOT_REVOKED_MEMO_MAX, pruneNotRevokedMemo } from "./revocation.ts";

const NOW = 1_000_000;

/** `count` entries, all expired at `NOW` unless `expiresAt` says otherwise. */
function memoOf(count: number, expiresAt: number): Map<string, number> {
  const m = new Map<string, number>();
  for (let i = 0; i < count; i += 1) m.set(`sid-${i}`, expiresAt);
  return m;
}

describe("pruneNotRevokedMemo", () => {
  it("does nothing below the ceiling — the common case must stay free", () => {
    const memo = memoOf(10, NOW - 1); // expired, but the map is small
    pruneNotRevokedMemo(memo, NOW, 100);
    expect(memo.size).toBe(10);
  });

  it("reclaims expired entries once the ceiling is reached", () => {
    const memo = memoOf(100, NOW - 1);
    pruneNotRevokedMemo(memo, NOW, 100);
    expect(memo.size).toBe(0);
  });

  it("keeps entries that are still live while dropping the expired ones", () => {
    const memo = memoOf(99, NOW - 1);
    memo.set("sid-live", NOW + 500);
    pruneNotRevokedMemo(memo, NOW, 100);
    expect(memo.size).toBe(1);
    expect(memo.get("sid-live")).toBe(NOW + 500);
  });

  it("treats an entry expiring exactly now as expired", () => {
    const memo = memoOf(100, NOW);
    pruneNotRevokedMemo(memo, NOW, 100);
    expect(memo.size).toBe(0);
  });

  it("clears outright when a burst leaves it full of LIVE entries", () => {
    // The bound has to hold even in the case the sweep cannot help. Dropping the map is safe: this is a
    // negative cache whose only job is saving a Redis round-trip, so the cost is latency on the next check.
    // It can never turn a revoked session into an allowed one — positive answers are never cached.
    const memo = memoOf(100, NOW + 500);
    pruneNotRevokedMemo(memo, NOW, 100);
    expect(memo.size).toBe(0);
  });

  it("is bounded by the shipped ceiling, not only by an injected one", () => {
    const memo = memoOf(NOT_REVOKED_MEMO_MAX, NOW - 1);
    pruneNotRevokedMemo(memo, NOW);
    expect(memo.size).toBe(0);
  });
});
