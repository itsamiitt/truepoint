// manifest.test.ts — the MV3 manifest's privileges are a HARD CONSTRAINT, and until now only a comment.
//
// manifest.config.ts is the most carefully-reasoned file in this app: every permission carries a note saying
// why it is there, why the broader alternative was rejected, and what went wrong the last time. None of it was
// enforced. A one-line edit widening `host_permissions` to `https://*/*`, or re-adding `optional_host_
// permissions`, or pointing `externally_connectable` at a wildcard, would pass lint, typecheck, every unit
// test and the build — and it would change what the extension is ALLOWED to read from the browser.
//
// That is CLAUDE.md rule 4 territory: "never implement, even if asked casually in-session: background/bulk
// scraping of LinkedIn or other logged-in sites … collection beyond user-initiated actions in the extension."
// Those are not enforced by the code that captures; they are enforced by the manifest that decides what the
// code can reach at all. A rule this repo says must never be implemented is worth more than a comment.
//
// The manifest is a FUNCTION of the build mode, so every invariant is asserted for BOTH modes. That matters:
// host_permissions were production-only once, which meant a development build could not reach a local API and
// the permission model protecting the release build blocked the dev build instead.
import { describe, expect, test } from "bun:test";
import manifestFn from "../manifest.config.ts";

type Manifest = {
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  externally_connectable?: { matches?: string[] };
  content_scripts?: Array<{
    matches?: string[];
    all_frames?: boolean;
    world?: string;
    run_at?: string;
  }>;
  content_security_policy?: { extension_pages?: string };
  background?: { service_worker?: string; type?: string };
};

/** `defineManifest` hands back the function itself; evaluate it the way Vite does. */
function manifestFor(mode: string): Manifest {
  const fn = manifestFn as unknown as (env: { mode: string; command: string }) => Manifest;
  return fn({ mode, command: "build" });
}

const MODES = ["production", "development"] as const;

/** Any host pattern that would grant reach beyond the named first-party origins + LinkedIn. */
const WILDCARD_HOST = /^\*:\/\/|^https?:\/\/\*\/|\/\/\*\.\*|<all_urls>/;

// A plain loop rather than `describe.each`: bun's types expect an array of TUPLES there, so a flat list of
// modes is a typecheck error — caught by `tsc --noEmit` on this app, since tests colocated in src/ are inside
// its tsconfig include.
for (const mode of MODES) {
  describe(`manifest (${mode} build)`, () => {
    const manifest = manifestFor(mode);

    test("declares exactly the three permissions that are actually called", () => {
      // Least privilege. `activeTab` and `scripting` were declared once and never called — no chrome.scripting
      // call, no tab injection — and an unused broad permission is both a review-surface expansion and a
      // leading cause of Web Store rejection. Exact equality on purpose: an ADDITION must fail here, and be
      // justified in the same commit that adds it.
      expect(manifest.permissions).toEqual(["storage", "alarms", "sidePanel"]);
    });

    test("does not take webRequest, cookies, tabs, identity, or debugger", () => {
      // Each of these is a capability the design explicitly rejected: we read only the VISIBLE DOM, the
      // companion-window auth (ADR-0045) uses chrome.windows + externally_connectable rather than
      // launchWebAuthFlow, and nothing here inspects network traffic or cookie jars.
      const forbidden = [
        "webRequest",
        "webRequestBlocking",
        "cookies",
        "tabs",
        "identity",
        "debugger",
      ];
      const declared = [...(manifest.permissions ?? []), ...(manifest.optional_permissions ?? [])];
      expect(declared.filter((p) => forbidden.includes(p))).toEqual([]);
    });

    test("grants no wildcard host, and no optional host permissions at all", () => {
      // "Capture anywhere" was once declared as https://*/* + http://*/* against a user-gesture request flow
      // that does not exist — chrome.permissions.request is never called — so it could only ever widen what the
      // store listing asks for, and http://*/* additionally advertised plaintext capture.
      expect(manifest.optional_host_permissions).toBeUndefined();
      const hosts = manifest.host_permissions ?? [];
      expect(hosts.length).toBeGreaterThan(0); // a manifest with none would pass the wildcard check vacuously
      expect(hosts.filter((h) => WILDCARD_HOST.test(h))).toEqual([]);
    });

    test("host permissions are the API origin and LinkedIn, and nothing else", () => {
      const hosts = manifest.host_permissions ?? [];
      const expectedApi =
        mode === "development" ? "http://localhost:3001/*" : "https://api.truepoint.in/*";
      expect([...hosts].sort()).toEqual([expectedApi, "https://*.linkedin.com/*"].sort());
      // The auth origin is deliberately ABSENT: the service worker reaches /auth/extension/{refresh,logout}
      // cross-origin under CORS (apps/auth/src/lib/cors.ts echoes an allow-listed origin with credentials),
      // which is narrower than holding a host permission for it. If this ever gains the auth origin, that
      // decision has been reversed and should be deliberate.
      expect(hosts.some((h) => h.includes("auth."))).toBe(false);
    });

    test("only the TruePoint web app may message the extension", () => {
      // Never a wildcard: externally_connectable is the door the auth handoff arrives through (ADR-0043/0045).
      // The SW still verifies sender.origin + a state nonce on top of this.
      const matches = manifest.externally_connectable?.matches ?? [];
      expect(matches).toEqual(["https://app.truepoint.in/*"]);
    });

    test("the content script runs on LinkedIn only, in the isolated world, top frame only", () => {
      const scripts = manifest.content_scripts ?? [];
      expect(scripts).toHaveLength(1);
      const [cs] = scripts;
      expect(cs?.matches).toEqual(["https://*.linkedin.com/*"]);
      // all_frames would inject into every iframe on the page — more surface, and none of it needed to read a
      // profile. `world` unset means ISOLATED; MAIN world would expose the page's own JS to our script and vice
      // versa, which the design rejects outright.
      expect(cs?.all_frames).toBe(false);
      expect(cs?.world).toBeUndefined();
    });

    test("the CSP admits no remote code", () => {
      const csp = manifest.content_security_policy?.extension_pages ?? "";
      expect(csp).toContain("script-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toContain("unsafe-inline");
      // A remote host in script-src is how a bundled extension starts executing code nobody reviewed.
      expect(csp).not.toMatch(/https?:\/\//);
    });

    test("the background is a module service worker, not a persistent page", () => {
      expect(manifest.background?.service_worker).toBe("src/background/index.ts");
      expect(manifest.background?.type).toBe("module");
    });
  });
}
