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
  permissions: ["storage", "alarms", "activeTab", "scripting", "sidePanel", "identity"],
  // Standing hosts: the SW must reach the API + auth origins; the content script runs on LinkedIn.
  host_permissions: [
    "https://api.truepoint.in/*",
    "https://auth.truepoint.in/*",
    "https://*.linkedin.com/*",
  ],
  // "Capture anywhere" is requested per-host on a user gesture, never granted at install.
  optional_host_permissions: ["https://*/*", "http://*/*"],
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
