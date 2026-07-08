// sessionCap.test.ts — the pure eviction decision behind the concurrent-session cap (AUTH-042). Proves it counts
// only ACTIVE sessions (revoked/expired excluded), evicts the OLDEST over the cap, and never evicts the
// just-created session. The DB glue (resolve the cap + list + revoke) is fail-open and covered by the engine
// itests + the resolve unit test in policy.test.ts.

import { describe, expect, it } from "bun:test";
import { sessionsToEvict } from "./session.ts";

const NOW = 1_000_000_000_000;
const s = (
  id: string,
  createdMsAgo: number,
  opts: { revoked?: boolean; expired?: boolean } = {},
) => ({
  id,
  createdAt: new Date(NOW - createdMsAgo),
  expiresAt: new Date(opts.expired ? NOW - 1000 : NOW + 3_600_000),
  revokedAt: opts.revoked ? new Date(NOW - 500) : null,
});

describe("sessionsToEvict", () => {
  it("returns [] when the user is at/under the cap", () => {
    expect(sessionsToEvict([s("new", 0), s("a", 1000)], 2, "new", NOW)).toEqual([]);
  });

  it("evicts the OLDEST over the cap, never the just-created session", () => {
    const sessions = [s("new", 0), s("a", 3000), s("b", 1000), s("c", 5000)]; // 4 active, cap 2 → evict 2 oldest
    expect(sessionsToEvict(sessions, 2, "new", NOW).sort()).toEqual(["a", "c"]);
  });

  it("excludes revoked + expired sessions from the active count", () => {
    const sessions = [
      s("new", 0),
      s("revoked", 1000, { revoked: true }),
      s("expired", 2000, { expired: true }),
      s("old", 3000),
    ]; // active = new + old = 2 ≤ cap 2 → nothing evicted
    expect(sessionsToEvict(sessions, 2, "new", NOW)).toEqual([]);
  });

  it("cap 1: keeps only the just-created session, evicts every other active one", () => {
    expect(
      sessionsToEvict([s("new", 0), s("a", 1000), s("b", 2000)], 1, "new", NOW).sort(),
    ).toEqual(["a", "b"]);
  });
});
