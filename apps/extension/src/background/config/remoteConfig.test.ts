// remoteConfig.test.ts — the LOCAL feature-flag cache. The point of these tests is less "does the getter
// work" and more "does this surface still make a promise it cannot keep".
//
// The file previously advertised a `killSwitch` and described itself as signed remote config, while nothing
// fetched or verified anything — an incident control that existed only as a field name. An operator reaching
// for it during an incident would have found nothing. These tests pin its removal, and pin that a stale
// storage entry written by an older build cannot smuggle it back in.

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
      bulkReveal: false,
      realtimeSse: false,
    });
  });

  test("there is NO killSwitch on the surface", async () => {
    // Removed deliberately: nothing remote could ever set it, so it advertised an incident control that did
    // not exist. The real kill is server-side (CHROME_EXTENSION_ENABLED, and 403 capture_disabled at the
    // capture ingress), enforced where the data lands rather than in a client that could be stale or tampered.
    const config = new RemoteConfig();
    await config.load();
    expect(Object.keys(config.snapshot()).sort()).toEqual([
      "bulkReveal",
      "captureEnabled",
      "realtimeSse",
    ]);
  });

  test("a stale cache from an older build cannot reintroduce killSwitch", async () => {
    // The reason load() merges key-by-key instead of spreading: an installed extension still has the old
    // object in chrome.storage.local, and a spread would put the removed key straight back on the live flags.
    stored.flags = { captureEnabled: true, bulkReveal: true, realtimeSse: false, killSwitch: true };
    const config = new RemoteConfig();
    await config.load();
    expect(config.snapshot()).not.toHaveProperty("killSwitch");
    // And the stale killSwitch must not disable anything on its way out.
    expect(config.isEnabled("captureEnabled")).toBe(true);
    expect(config.isEnabled("bulkReveal")).toBe(true);
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
    await config.save({ bulkReveal: true });
    expect(config.isEnabled("bulkReveal")).toBe(true);

    const reloaded = new RemoteConfig();
    await reloaded.load();
    expect(reloaded.isEnabled("bulkReveal")).toBe(true);
  });
});
