import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };
import { hostPermissionsForMode } from "./src/shared/origins.ts";

// MV3 manifest — least-privilege, thin-producer, compliant capture.
// Design + rationale: docs/planning/chrome-extension/02, 03 §1, ADR-0043.
// - No `*://*/*`: only the API/auth origins (needed by the SW) + LinkedIn (content script) are
//   granted at install; every other host is opt-in via `optional_host_permissions` on a user gesture.
// - No MAIN-world injection, no `webRequest`, no `cookies` — we read only the visible DOM.
// A FUNCTION, not a literal: host_permissions must follow the build mode. They were production-only, so a
// development build could not reach a local API even once shared/env.ts pointed at one — the permission model
// that protects the release build would have blocked the dev build instead. Derived from the same
// src/shared/origins.ts the Vite `define` uses, so the granted host and the called host cannot drift.
export default defineManifest((env) => ({
  manifest_version: 3,
  name: "TruePoint — Prospect Capture",
  short_name: "TruePoint",
  version: pkg.version,
  // Fixed public key so every unpacked/zip install resolves to the SAME extension id
  // (icdgalkafhhbgalmahjmibgbjkcmbkif) — the id EXTENSION_ORIGINS pins and the mint route's audience
  // requires (X15). The Chrome Web Store ignores/strips `key` on publish and assigns its own id; if the
  // extension is ever published, add the store-assigned id to EXTENSION_ORIGINS alongside this one.
  key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvAtK1A0J5HEI0C5HNOVFsfYsoYlxOjfZ/QMDkUPh766NXxGSzGxEtl7cMrOS8bVOZOqw1YqITt56q5xeK/Lho9D66NFgjSPYMyQKnb9JsGlekuzS91fLq0Zj25EFUuMDc9tSgIWjWNethmIwZQYZqfkzEQ69OU3wiFj2pEmAuZiZQsVrJzoK64WiqN0sYfUgvpcoYuhfGnxlnPNdHVGELjK56YElq7WVQQ1burL/OWCvpjMp9M6oc4PfZ0WIq+vxFMZyIa/whCVTQWe1CcHVXHmRmNO8PmFoQmbrVofI8OWggGbuDaeC0GxqE8XzqPSoUooOMMy9ACOy/afLkug0FwIDAQAB",
  // User-facing (chrome://extensions + store) — brand voice: find/reveal/score/pursue, verified, precise.
  description: "Find, reveal, score and pursue — capture verified prospects from anywhere.",
  minimum_chrome_version: "116",
  action: {
    default_title: "TruePoint — Aim true.",
    default_popup: "src/ui/popup/index.html",
  },
  background: {
    service_worker: "src/background/index.ts",
    type: "module",
  },
  side_panel: {
    default_path: "src/ui/panel/index.html",
  },
  // No `identity` — the companion-window auth (ADR-0045) uses chrome.windows + externally_connectable,
  // not launchWebAuthFlow.
  // Least privilege (truepoint-extension-architecture rule 3): every entry here must be a permission the code
  // actually calls. `activeTab` and `scripting` were declared but never used — no chrome.scripting call and no
  // tab injection anywhere — and unused broad permissions are both a review-surface expansion and a leading
  // cause of Web Store rejection. `storage`, `alarms`, and `sidePanel` are each in use.
  permissions: ["storage", "alarms", "sidePanel"],
  // Standing hosts: the SW reaches the API for capture/reveal + the extension token endpoints; the content
  // script runs on LinkedIn. (The companion window navigates to app.truepoint.in — a window nav needs no
  // host permission; the handoff arrives via externally_connectable below.)
  host_permissions: hostPermissionsForMode(env.mode),
  // NO optional_host_permissions. "Capture anywhere" was declared as https://*/* + http://*/* against a
  // user-gesture request flow that does not exist: chrome.permissions.request is never called, so the entry
  // could only ever widen what the store listing asks for. `http://*/*` additionally advertised plaintext
  // capture. Re-add a NARROW list at the moment the request flow actually ships — https only.
  // Only the TruePoint web app may message the extension (the auth handoff, ADR-0043/0045). Never a wildcard;
  // the SW still verifies sender.origin + a state nonce before trusting any message (doc 12 §7).
  externally_connectable: { matches: ["https://app.truepoint.in/*"] },
  content_scripts: [
    {
      matches: ["https://*.linkedin.com/*"],
      js: ["src/content/index.ts"],
      run_at: "document_idle",
      all_frames: false,
    },
  ],
  icons: {
    "16": "src/assets/icons/16.png",
    "32": "src/assets/icons/32.png",
    "48": "src/assets/icons/48.png",
    "128": "src/assets/icons/128.png",
  },
  // Strict CSP — bundled scripts only, no remote code, no localhost devtools ports (cf. Apollo, 01 §1.3).
  content_security_policy: {
    // Self-hosted Geist woff2 load as 'self' (MV3 blocks remote fonts); no remote code.
    extension_pages: "script-src 'self'; object-src 'self'; font-src 'self'",
  },
}));
