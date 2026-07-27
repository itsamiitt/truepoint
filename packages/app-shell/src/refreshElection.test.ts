// refreshElection.test.ts — one refresh per browser rather than one per tab. The properties worth pinning are
// the ones that decide whether this is safe to put in front of token rotation: exactly one winner among
// simultaneous tabs, an abandoned claim never wedges refreshing forever, a tab never clears someone else's
// claim, and an untrusted same-origin broadcast cannot inject a token.

import { describe, expect, test } from "bun:test";
import {
  type ElectionDeps,
  LOCK_TTL_MS,
  broadcastRefreshResult,
  parseRefreshMessage,
  releaseRefreshLock,
  tryAcquireRefreshLock,
} from "./refreshElection.ts";

/** One shared localStorage-alike, several tabs pointing at it. */
function browser() {
  const map = new Map<string, string>();
  let clock = 1_000_000;
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
  };
  const posted: unknown[] = [];
  const tab = (tabId: string): ElectionDeps => ({
    storage,
    channel: { postMessage: (m: unknown) => void posted.push(m) },
    now: () => clock,
    tabId,
  });
  return { tab, posted, advance: (ms: number) => (clock += ms), raw: map };
}

describe("tryAcquireRefreshLock", () => {
  test("exactly ONE of several tabs wins", () => {
    // The whole point: N tabs otherwise fire N rotation chains within milliseconds, each a DB revoke+insert
    // plus a Redis write, surviving only on the 30s reuse-grace.
    const b = browser();
    const winners = ["a", "b", "c", "d"].filter((id) => tryAcquireRefreshLock(b.tab(id)));
    expect(winners).toHaveLength(1);
  });

  test("the holder can re-acquire its own claim (a retry is not a deadlock)", () => {
    const b = browser();
    const a = b.tab("a");
    expect(tryAcquireRefreshLock(a)).toBe(true);
    expect(tryAcquireRefreshLock(a)).toBe(true);
  });

  test("a live claim blocks other tabs for its TTL", () => {
    const b = browser();
    expect(tryAcquireRefreshLock(b.tab("a"))).toBe(true);
    b.advance(LOCK_TTL_MS - 1);
    expect(tryAcquireRefreshLock(b.tab("b"))).toBe(false);
  });

  test("an ABANDONED claim is taken over — a tab closed mid-refresh must not wedge the browser", () => {
    // Without expiry, closing the one tab that happened to win would stop every other tab from ever
    // refreshing, and the user would be silently logged out when the token expired.
    const b = browser();
    expect(tryAcquireRefreshLock(b.tab("a"))).toBe(true);
    b.advance(LOCK_TTL_MS + 1);
    expect(tryAcquireRefreshLock(b.tab("b"))).toBe(true);
  });

  test("a corrupt lock entry does not wedge refreshing forever", () => {
    const b = browser();
    b.raw.set("tp.refresh.lock", "{not json");
    expect(tryAcquireRefreshLock(b.tab("a"))).toBe(true);
  });
});

describe("releaseRefreshLock", () => {
  test("the holder releases, freeing the next tab immediately", () => {
    const b = browser();
    const a = b.tab("a");
    expect(tryAcquireRefreshLock(a)).toBe(true);
    releaseRefreshLock(a);
    expect(tryAcquireRefreshLock(b.tab("b"))).toBe(true);
  });

  test("a tab NEVER clears another tab's claim", () => {
    // A late release from a preempted tab would otherwise green-light a third tab while the current holder is
    // still mid-refresh — reintroducing the concurrent rotation this exists to prevent.
    const b = browser();
    expect(tryAcquireRefreshLock(b.tab("a"))).toBe(true);
    releaseRefreshLock(b.tab("b")); // b never held it
    expect(tryAcquireRefreshLock(b.tab("c"))).toBe(false);
  });
});

describe("result sharing", () => {
  test("the winner broadcasts a result the others can adopt", () => {
    const b = browser();
    broadcastRefreshResult(b.tab("a"), { token: "tok", expiresIn: 900 });
    expect(parseRefreshMessage(b.posted[0])).toEqual({ token: "tok", expiresIn: 900 });
  });

  test("no channel (BroadcastChannel unavailable) degrades quietly to today's behaviour", () => {
    const b = browser();
    const noChannel: ElectionDeps = { ...b.tab("a"), channel: undefined };
    expect(() => broadcastRefreshResult(noChannel, { token: "t", expiresIn: 1 })).not.toThrow();
  });

  test("a malformed or hostile broadcast cannot inject a token", () => {
    // Everything on this channel is untrusted input from another script on the same origin, so it is
    // validated rather than cast — a bad payload must yield null, not a token the app would then present.
    for (const bad of [
      null,
      undefined,
      "string",
      42,
      {},
      { type: "other", token: "t", expiresIn: 1 },
      { type: "tp.refresh.result" },
      { type: "tp.refresh.result", token: "", expiresIn: 1 },
      { type: "tp.refresh.result", token: "t", expiresIn: 0 },
      { type: "tp.refresh.result", token: "t", expiresIn: -5 },
      { type: "tp.refresh.result", token: "t", expiresIn: Number.NaN },
      { type: "tp.refresh.result", token: 5, expiresIn: 5 },
    ]) {
      expect(parseRefreshMessage(bad)).toBeNull();
    }
  });
});
