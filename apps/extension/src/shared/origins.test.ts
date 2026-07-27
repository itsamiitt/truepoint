// origins.test.ts — the extension's origin resolution. The bug this guards against cost real money rather
// than correctness: shared/env.ts hard-coded production and referred to a Vite `define` that did not exist,
// so `bun run dev` pointed the service worker at PRODUCTION and a reveal triggered while developing spent
// real credits against a real tenant.

import { describe, expect, test } from "bun:test";
import {
  DEVELOPMENT_ORIGINS,
  PRODUCTION_ORIGINS,
  hostPermissionsForMode,
  originsForMode,
} from "./origins.ts";

describe("originsForMode", () => {
  test("a DEVELOPMENT build never points at production", () => {
    const dev = originsForMode("development");
    expect(dev).toEqual(DEVELOPMENT_ORIGINS);
    for (const origin of Object.values(dev)) {
      expect(origin).not.toContain("truepoint.in");
    }
  });

  test("production mode uses the production origins", () => {
    expect(originsForMode("production")).toEqual(PRODUCTION_ORIGINS);
  });

  test("an unknown or missing mode falls back to PRODUCTION, not localhost", () => {
    // The asymmetry is deliberate: pointing at localhost by accident is a broken extension a developer
    // notices immediately, while pointing at production by accident spends money silently. So the ambiguous
    // cases resolve to the origins that at least work for a real user.
    expect(originsForMode(undefined)).toEqual(PRODUCTION_ORIGINS);
    expect(originsForMode("")).toEqual(PRODUCTION_ORIGINS);
    expect(originsForMode("preview")).toEqual(PRODUCTION_ORIGINS);
    expect(originsForMode("Development")).toEqual(PRODUCTION_ORIGINS); // exact match only
  });

  test("every origin is an absolute http(s) URL with no trailing slash", () => {
    // A trailing slash would produce `…//api/v1` once API_BASE concatenates.
    for (const set of [PRODUCTION_ORIGINS, DEVELOPMENT_ORIGINS]) {
      for (const origin of Object.values(set)) {
        expect(origin).toMatch(/^https?:\/\/[^/]+$/);
      }
    }
  });

  test("production origins are HTTPS", () => {
    for (const origin of Object.values(PRODUCTION_ORIGINS)) {
      expect(origin.startsWith("https://")).toBe(true);
    }
  });
});

describe("hostPermissionsForMode", () => {
  test("the granted API host matches the API origin the SW will actually call", () => {
    // These drifting apart is its own failure: production-only host_permissions meant a dev build was blocked
    // by the permission model that exists to constrain the RELEASE build.
    for (const mode of ["development", "production", undefined]) {
      const granted = hostPermissionsForMode(mode);
      expect(granted).toContain(`${originsForMode(mode).api}/*`);
    }
  });

  test("LinkedIn is always granted — it is what the content script runs on", () => {
    for (const mode of ["development", "production"]) {
      expect(hostPermissionsForMode(mode)).toContain("https://*.linkedin.com/*");
    }
  });

  test("no wildcard-everything host is ever granted", () => {
    // `*://*/*` / `http://*/*` would widen what the store listing asks for; the manifest comment records that
    // an earlier version had exactly that.
    for (const mode of ["development", "production", undefined]) {
      for (const entry of hostPermissionsForMode(mode)) {
        expect(entry).not.toBe("*://*/*");
        expect(entry).not.toBe("http://*/*");
        expect(entry).not.toBe("https://*/*");
      }
    }
  });
});
