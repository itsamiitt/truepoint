// remoteConfig.test.ts — the LOCAL feature-flag cache. The point of these tests is less "does the getter
// work" and more "does this surface still make a promise it cannot keep".
//
// The file previously advertised a `killSwitch` and described itself as signed remote config, while nothing
// fetched or verified anything — an incident control that existed only as a field name. An operator reaching
// for it during an incident would have found nothing. `bulkReveal` went the same way later: no code ever
// read it. These tests pin both removals, and pin that a stale storage entry written by an older build
// cannot smuggle a removed key back in.

import { beforeEach, describe, expect, mock, test } from "bun:test";

let stored: Record<string, unknown> = {};

mock.module("../../shared/storage.ts", () => ({
  getLocal: async (key: string) => stored[key],
  setLocal: async (key: string, value: unknown) => {
    stored[key] = value;
  },
}));

const { RemoteConfig } = await import("./remoteConfig.ts");

beforeEach(() => {
  stored = {};
});

describe("RemoteConfig (local flags)", () => {
  test("defaults: capture on, the rest off", async () => {
    const config = new RemoteConfig();
    await config.load();
    expect(config.snapshot()).toEqual({
      captureEnabled: true,
      realtimeSse: false,
    });
  });

  test("there is NO killSwitch and NO bulkReveal on the surface", async () => {
    // Both removed deliberately: nothing could ever operate them, so each advertised a control that did
    // not exist. The real kill is server-side (CHROME_EXTENSION_ENABLED, and 403 capture_disabled at the
    // capture ingress), enforced where the data lands rather than in a client that could be stale or tampered.
    const config = new RemoteConfig();
    await config.load();
    expect(Object.keys(config.snapshot()).sort()).toEqual(["captureEnabled", "realtimeSse"]);
  });

  test("a stale cache from an older build cannot reintroduce removed keys", async () => {
    // The reason load() merges key-by-key instead of spreading: an installed extension still has the old
    // object in chrome.storage.local, and a spread would put removed keys straight back on the live flags.
    stored.flags = { captureEnabled: true, bulkReveal: true, realtimeSse: false, killSwitch: true };
    const config = new RemoteConfig();
    await config.load();
    expect(config.snapshot()).not.toHaveProperty("killSwitch");
    expect(config.snapshot()).not.toHaveProperty("bulkReveal");
    // And the stale keys must not disable anything on their way out.
    expect(config.isEnabled("captureEnabled")).toBe(true);
  });

  test("cached values override defaults; unknown keys are ignored", async () => {
    stored.flags = { captureEnabled: false, realtimeSse: true, somethingElse: 1 };
    const config = new RemoteConfig();
    await config.load();
    expect(config.isEnabled("captureEnabled")).toBe(false);
    expect(config.isEnabled("realtimeSse")).toBe(true);
    expect(config.snapshot()).not.toHaveProperty("somethingElse");
  });

  test("save persists and is readable back", async () => {
    const config = new RemoteConfig();
    await config.load();
    await config.save({ captureEnabled: false });
    expect(config.isEnabled("captureEnabled")).toBe(false);

    const reloaded = new RemoteConfig();
    await reloaded.load();
    expect(reloaded.isEnabled("captureEnabled")).toBe(false);
  });
});
