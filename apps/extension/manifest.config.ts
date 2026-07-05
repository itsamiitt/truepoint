import { defineManifest } from "@crxjs/vite-plugin";
import pkg from "./package.json" with { type: "json" };

// MV3 manifest — least-privilege, thin-producer, compliant capture.
// Design + rationale: docs/planning/chrome-extension/02, 03 §1, ADR-0043.
// - No `*://*/*`: only the API/auth origins (needed by the SW) + LinkedIn (content script) are
//   granted at install; every other host is opt-in via `optional_host_permissions` on a user gesture.
// - No MAIN-world injection, no `webRequest`, no `cookies` — we read only the visible DOM.
export default defineManifest({
  manifest_version: 3,
  name: "TruePoint — Prospect Capture",
  short_name: "TruePoint",
  version: pkg.version,
  description: pkg.description,
  minimum_chrome_version: "116",
  action: {
    default_title: "TruePoint",
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
  permissions: ["storage", "alarms", "activeTab", "scripting", "sidePanel"],
  // Standing hosts: the SW reaches the API for capture/reveal + the extension token endpoints; the content
  // script runs on LinkedIn. (The companion window navigates to app.truepoint.in — a window nav needs no
  // host permission; the handoff arrives via externally_connectable below.)
  host_permissions: ["https://api.truepoint.in/*", "https://*.linkedin.com/*"],
  // "Capture anywhere" is requested per-host on a user gesture, never granted at install.
  optional_host_permissions: ["https://*/*", "http://*/*"],
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
    extension_pages: "script-src 'self'; object-src 'self'",
  },
});
