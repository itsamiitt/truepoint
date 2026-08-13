// extensionScope.test.ts — guards AUTH-065. An extension-scoped token must be confined to the prospecting
// allow-list; a web/admin token (scope:[]) must NEVER be treated as extension-scoped (that would break every
// non-extension caller). Matching must be method-aware and exact (no prefix escalation).
import { describe, expect, it } from "bun:test";
import {
  EXTENSION_SCOPE,
  extensionRouteAllowed,
  extensionScopeViolationLog,
  isExtensionToken,
} from "./extensionScope.ts";

describe("isExtensionToken", () => {
  it("is true only when the scope claim carries 'extension'", () => {
    expect(isExtensionToken({ scope: [EXTENSION_SCOPE] })).toBe(true);
    expect(isExtensionToken({ scope: ["extension", "read"] })).toBe(true);
  });
  it("is false for a web/admin token (scope:[]) — never restricted", () => {
    expect(isExtensionToken({ scope: [] })).toBe(false);
    expect(isExtensionToken({ scope: ["billing"] })).toBe(false);
  });
});

describe("extensionRouteAllowed", () => {
  it("allows exactly the routes the extension calls", () => {
    expect(extensionRouteAllowed("POST", "/api/v1/ingest")).toBe(true);
    expect(extensionRouteAllowed("POST", "/api/v1/contacts/abc-123/reveal")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/credits/balance")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/credits/reveal-costs")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/me")).toBe(true);
    expect(extensionRouteAllowed("GET", "/api/v1/orgs")).toBe(true);
    // The LinkedIn→contact seam. It needs its own rule: two segments after /contacts, so even back when a
    // one-segment `/contacts/:id` rule existed it could never have covered this (`:id` → `[^/]+`).
    expect(extensionRouteAllowed("GET", "/api/v1/contacts/by-linkedin/satyanadella")).toBe(true);
    // The SW-held SSE consumer (dark behind the realtimeSse flag, but must not need an authz change to enable).
    expect(extensionRouteAllowed("GET", "/api/v1/events/stream")).toBe(true);
  });

  it("is method-aware (an allowed path with the wrong verb is denied)", () => {
    // Uses by-linkedin because it is a path the list DOES grant (for GET) — asserting the wrong verb on a
    // path that is denied for every verb would pass without testing method-awareness at all.
    expect(extensionRouteAllowed("DELETE", "/api/v1/contacts/by-linkedin/satyanadella")).toBe(
      false,
    );
    expect(extensionRouteAllowed("POST", "/api/v1/me")).toBe(false);
    expect(extensionRouteAllowed("GET", "/api/v1/ingest")).toBe(false);
  });

  it("denies the rest of the tenant API (the AUTH-065 hole)", () => {
    for (const [m, p] of [
      ["POST", "/api/v1/imports"],
      ["GET", "/api/v1/admin/tenants"],
      ["POST", "/api/v1/billing/checkout"],
      ["GET", "/api/v1/contacts"], // list is NOT on the allow-list (only a single captured contact)
      // Contact-detail: no such endpoint exists, and the extension never asks for one (audit 32 · C9). The
      // grant was removed rather than left as a placeholder so building it later cannot silently inherit
      // extension access — see the note in the allow-list itself.
      ["GET", "/api/v1/contacts/abc-123"],
      ["POST", "/api/v1/contacts/abc/reveal/../../admin"], // no prefix/traversal escalation
    ] as const) {
      expect(extensionRouteAllowed(m, p)).toBe(false);
    }
  });

  it("ignores a query string and is case-insensitive on the verb", () => {
    expect(extensionRouteAllowed("get", "/api/v1/credits/balance?ts=1")).toBe(true);
  });
});

// ── drift guard ───────────────────────────────────────────────────────────────────────────────────────
// The allow-list is deny-by-default, so an endpoint the extension calls but nobody allow-listed does not fail
// loudly — it silently 403s the live extension the moment EXTENSION_SCOPE_ENFORCE flips. That is exactly how
// GET /contacts/by-linkedin/:publicId and GET /events/stream came to be missing. This reads the extension's
// ACTUAL request sites and asserts each path is reachable, so adding a call without an allow-list entry fails
// here instead of in production. Reading a sibling app's source is fine: dependency-cruiser excludes test
// files from the apps-never-import-apps rule, and this is a runtime file read, not an import.
const EXTENSION_SOURCES = [
  "../../../extension/src/background/api/client.ts",
  "../../../extension/src/background/eventStream.ts",
  "../../../extension/src/background/auth/account.ts",
] as const;

/** Path literals reached via the SW's two call shapes: `fetch(`${API_BASE}<path>`)` and `this.request("<path>")`. */
function extractCalledPaths(source: string): string[] {
  const paths = new Set<string>();
  for (const m of source.matchAll(/API_BASE\}(\/[^`"']*)/g)) if (m[1]) paths.add(m[1]);
  for (const m of source.matchAll(/this\.request(?:<[^>]*>)?\(\s*[`"'](\/[^`"']*)/g))
    if (m[1]) paths.add(m[1]);
  return [...paths];
}

/** `/contacts/${encodeURIComponent(id)}/reveal` → `/contacts/sample/reveal` so it can be matched as a route. */
const normalize = (p: string): string => p.replace(/\$\{[^}]*\}/g, "sample");

const VERBS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

describe("extension allow-list covers every endpoint the extension actually calls", () => {
  it("finds the request sites (guards against this test silently reading nothing)", async () => {
    const all: string[] = [];
    for (const rel of EXTENSION_SOURCES) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      all.push(...extractCalledPaths(src));
    }
    // If the extension's call shapes are refactored, this floor fails and the guard gets fixed rather than
    // quietly passing on an empty set.
    expect(all.length).toBeGreaterThanOrEqual(7);
  });

  it("allow-lists each called path under at least one verb", async () => {
    for (const rel of EXTENSION_SOURCES) {
      const src = await Bun.file(new URL(rel, import.meta.url)).text();
      for (const raw of extractCalledPaths(src)) {
        const path = `/api/v1${normalize(raw)}`;
        const reachable = VERBS.some((v) => extensionRouteAllowed(v, path));
        if (!reachable) {
          throw new Error(
            `${raw} is called by apps/extension but is NOT on EXTENSION_ALLOW_LIST — it will 403 once EXTENSION_SCOPE_ENFORCE=true. Add a rule in extensionScope.ts.`,
          );
        }
      }
    }
  });
});

describe("extensionScopeViolationLog", () => {
  it("emits the alertable prefix + mode + method/path, and strips the query", () => {
    const line = extensionScopeViolationLog("post", "/api/v1/imports?x=1", "denied");
    expect(line).toStartWith("[authz] extension-scope denied");
    expect(line).toContain("method=POST");
    expect(line).toContain("path=/api/v1/imports");
    expect(line).not.toContain("x=1");
  });
});
